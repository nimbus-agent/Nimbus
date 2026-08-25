import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import pino from "pino";
import { createLaunchdarklySyncable } from "../../../src/connectors/launchdarkly-sync.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { ProviderRateLimiter } from "../../../src/sync/rate-limiter.ts";
import { buildSyncCapabilities } from "../../../src/sync/sync-capabilities.ts";
import type { SyncContext } from "../../../src/sync/types.ts";
import { createMockVault } from "../../../src/vault/mock.ts";
import { requestUrl } from "../../helpers/request-url.ts";

interface RecordedReq {
  method: string;
  path: string;
  auth: string | null;
  search: URLSearchParams;
}

interface FakeLdConfig {
  projects: Array<{ key: string }>;
  flagsByProject: Record<string, unknown[]>;
  flagsStatus?: number;
}

interface FakeLd {
  baseUrl: string;
  requests: RecordedReq[];
  stop(): void;
}

function startFakeLd(config: FakeLdConfig): FakeLd {
  const requests: RecordedReq[] = [];
  let server: Server | undefined;
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const u = new URL(req.url);
      requests.push({
        method: req.method,
        path: u.pathname,
        auth: req.headers.get("authorization"),
        search: u.searchParams,
      });
      if (u.pathname === "/api/v2/projects") {
        return Response.json({ items: config.projects });
      }
      const flagsMatch = /^\/api\/v2\/flags\/([^/]+)$/.exec(u.pathname);
      if (flagsMatch !== null) {
        if (config.flagsStatus !== undefined && config.flagsStatus !== 200) {
          return new Response("error", { status: config.flagsStatus });
        }
        const projectKey = decodeURIComponent(flagsMatch[1] ?? "");
        return Response.json({ items: config.flagsByProject[projectKey] ?? [] });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const baseUrl = `http://${server.hostname}:${server.port}`;
  return { baseUrl, requests, stop: () => server?.stop(true) };
}

interface Harness {
  vault: ReturnType<typeof createMockVault>;
  db: Database;
  ctx: SyncContext;
  fake: FakeLd;
  cleanup: () => void;
}

function startHarness(config: FakeLdConfig): Harness {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const vault = createMockVault();
  const fake = startFakeLd(config);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    const rewritten = url.replace("https://app.launchdarkly.com", fake.baseUrl);
    return originalFetch(rewritten, init);
  };
  return {
    db,
    vault,
    fake,
    cleanup: () => {
      globalThis.fetch = originalFetch;
      fake.stop();
      db.close();
    },
    ctx: {
      ...buildSyncCapabilities({ vault, db, depth: "full" }, "launchdarkly"),
      logger: pino({ level: "silent" }),
      rateLimiter: new ProviderRateLimiter({
        launchdarkly: { requestsPerMinute: 600_000, burstSize: 10_000 },
      }),
    },
  };
}

function flag(key: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key,
    name: `Flag ${key}`,
    kind: "boolean",
    tags: ["t"],
    creationDate: 1_700_000_000_000,
    environments: { production: { on: true, lastModified: 1_700_000_500_000 } },
    ...over,
  };
}

describe("launchdarkly-sync against Bun.serve fake API", () => {
  let h: Harness | undefined;
  afterEach(() => {
    h?.cleanup();
    h = undefined;
  });

  test("walks projects → flags and upserts well-formed rows with raw-token auth", async () => {
    h = startHarness({
      projects: [{ key: "default" }],
      flagsByProject: { default: [flag("flag-a"), flag("flag-b", { kind: "multivariate" })] },
    });
    await h.vault.set("launchdarkly.token", "api-test-token");

    const syncable = createLaunchdarklySyncable({ ensureLaunchdarklyMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-launchdarkly1:")).toBe(true);

    for (const r of h.fake.requests) {
      expect(r.auth).toBe("api-test-token");
    }
    expect(h.fake.requests.filter((r) => r.path === "/api/v2/projects")).toHaveLength(1);

    const rows = h.db
      .query<{ external_id: string; metadata: string }, []>(
        "SELECT external_id, metadata FROM item WHERE service = 'launchdarkly' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["default:flag-a", "default:flag-b"]);
    const a = JSON.parse(rows[0]?.metadata ?? "{}") as Record<string, unknown>;
    expect(a["kind"]).toBe("boolean");
    expect(a["project_key"]).toBe("default");
    expect(a["env_states"]).toEqual({ production: true });
  });

  test("when launchdarkly.project_key is set, skips the /projects round-trip", async () => {
    h = startHarness({
      projects: [{ key: "default" }, { key: "other" }],
      flagsByProject: { mobile: [flag("m1")] },
    });
    await h.vault.set("launchdarkly.token", "tok");
    await h.vault.set("launchdarkly.project_key", "mobile");
    const syncable = createLaunchdarklySyncable({ ensureLaunchdarklyMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(1);
    expect(h.fake.requests.filter((r) => r.path === "/api/v2/projects")).toHaveLength(0);
    expect(h.fake.requests.some((r) => r.path === "/api/v2/flags/mobile")).toBe(true);
  });

  test("noop when launchdarkly.token is unset — no requests", async () => {
    h = startHarness({ projects: [], flagsByProject: {} });
    const syncable = createLaunchdarklySyncable({ ensureLaunchdarklyMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("a 429 on the flags endpoint degrades gracefully (no throw, zero upserts, pass-1 cursor)", async () => {
    h = startHarness({
      projects: [{ key: "default" }],
      flagsByProject: { default: [flag("flag-a")] },
      flagsStatus: 429,
    });
    await h.vault.set("launchdarkly.token", "tok");
    const syncable = createLaunchdarklySyncable({ ensureLaunchdarklyMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-launchdarkly1:")).toBe(true);
  });

  test("flag count of exactly PAGE_SIZE triggers a second offset page", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => flag(`flag-${String(i)}`));
    h = startHarness({
      projects: [{ key: "default" }],
      flagsByProject: { default: fullPage },
    });
    await h.vault.set("launchdarkly.token", "tok");
    const syncable = createLaunchdarklySyncable({ ensureLaunchdarklyMcpRunning: async () => {} });
    await syncable.sync(h.ctx, null);
    const flagCalls = h.fake.requests.filter((r) => r.path === "/api/v2/flags/default");
    expect(flagCalls.length).toBeGreaterThanOrEqual(2);
    expect(flagCalls[0]?.search.get("offset")).toBe("0");
    expect(flagCalls[1]?.search.get("offset")).toBe("100");
  });
});
