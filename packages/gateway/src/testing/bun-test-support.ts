import { Database } from "bun:sqlite";
import { expect } from "bun:test";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import pino from "pino";
import { OAUTH_PROVIDERS } from "../auth/oauth-registry.ts";
import type { ConnectorServiceId } from "../connectors/connector-catalog.ts";
import { LocalIndex } from "../index/local-index.ts";
import { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import { buildSyncCapabilities, unboundSyncCapabilities } from "../sync/sync-capabilities.ts";
import type { SyncContext } from "../sync/types.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";

export function createMemoryVault(): NimbusVault {
  const m = new Map<string, string>();
  return {
    async set(key: string, value: string): Promise<void> {
      m.set(key, value);
    },
    async get(key: string): Promise<string | null> {
      return m.get(key) ?? null;
    },
    async delete(key: string): Promise<void> {
      m.delete(key);
    },
    async listKeys(prefix?: string): Promise<string[]> {
      const keys = [...m.keys()].sort((a, b) => a.localeCompare(b));
      if (prefix === undefined || prefix === "") {
        return keys;
      }
      return keys.filter((k) => k.startsWith(prefix));
    },
  };
}

export function openMemoryIndexDatabase(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

export function createSyncTestContext(
  db: Database,
  vault: NimbusVault,
  serviceId?: ConnectorServiceId,
): SyncContext {
  return {
    ...(serviceId === undefined
      ? unboundSyncCapabilities()
      : buildSyncCapabilities({ vault, db, depth: "full" }, serviceId)),
    db,
    vault,
    logger: pino({ level: "silent" }),
    rateLimiter: new ProviderRateLimiter(),
    // Wave 7b SyncContext members — personal-credential defaults for sync tests.
    sandboxCwd: os.tmpdir(),
    credentialFor: () => ({ credential: "personal" }),
    runTeamList: async () => [],
    // Connector sync tests exercise the full-body path unless a test overrides it.
    depth: "full",
  };
}

export function requestUrlString(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

export function registerGlobalFetchRestore(afterEachImpl: (callback: () => void) => void): void {
  const originalFetch = globalThis.fetch;
  afterEachImpl(() => {
    globalThis.fetch = originalFetch;
  });
}

function testOAuthVaultJson(): string {
  return JSON.stringify({
    accessToken: "t",
    refreshToken: "r",
    expiresAt: Date.now() + 3_600_000,
  });
}

export async function createOAuthConnectorTestSetup(
  provider: "google" | "microsoft",
  /**
   * The CONNECTOR whose context this is — `gmail`, `onedrive`, and so on. The provider alone is not
   * enough: four Google connectors share one provider but each resolves its own vault keys, so a
   * context bound to the provider would scope three of them wrongly. Omitted, the capabilities
   * throw rather than silently reading nothing.
   */
  serviceId?: ConnectorServiceId,
): Promise<{ db: Database; vault: NimbusVault; ctx: SyncContext }> {
  const vault = createMemoryVault();
  await vault.set(OAUTH_PROVIDERS[provider].vaultKey, testOAuthVaultJson());
  const db = openMemoryIndexDatabase();
  return { db, vault, ctx: createSyncTestContext(db, vault, serviceId) };
}

export function expectPrefixedCursorCodecRoundTrip<T>(
  samples: readonly T[],
  encode: (c: T) => string,
  decode: (raw: string) => T | undefined,
  prefix: string,
): void {
  for (const s of samples) {
    const enc = encode(s);
    expect(enc.startsWith(prefix)).toBe(true);
    expect(decode(enc)).toEqual(s);
  }
}

async function pkceTestHttpGetStatus(url: string): Promise<number> {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`PKCE test helper expected http(s) callback URL, got ${u.protocol}`);
  }
  const mod = u.protocol === "https:" ? https : http;
  return await new Promise((resolve, reject) => {
    const req = mod.request(u, { method: "GET", headers: { Connection: "close" } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

export function googlePkceOpenUrlCompleter(
  code: string,
  options?: {
    expectAccountsHost?: boolean;
    missingParamsMessage?: string;
    assertFetchOk?: boolean;
  },
): (url: string) => Promise<void> {
  const msg = options?.missingParamsMessage ?? "expected redirect_uri and state in auth URL";
  const assertOk = options?.assertFetchOk ?? true;
  return async (url: string) => {
    const u = new URL(url);
    if (options?.expectAccountsHost === true) {
      expect(u.hostname).toBe("accounts.google.com");
    }
    const ru = u.searchParams.get("redirect_uri");
    const st = u.searchParams.get("state");
    if (ru === null || ru === "" || st === null || st === "") {
      throw new Error(msg);
    }
    const cb = new URL(ru);
    cb.searchParams.set("code", code);
    cb.searchParams.set("state", st);
    const status = await pkceTestHttpGetStatus(cb.toString());
    if (assertOk) {
      expect(status >= 200 && status < 300).toBe(true);
    }
  };
}
