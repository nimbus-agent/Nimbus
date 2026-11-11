/**
 * `ensureGoogleDriveMcp` and the Gmail archive's scope gate (Phase 10 SA2, OR-10-7): the Gmail child
 * ALONE gets `GOOGLE_OAUTH_SCOPES` (the connector lists `gmail_thread_archive` only when the token
 * holds `gmail.modify`); Drive, Photos and Meet get the access token and nothing else. A credential
 * that records no scopes passes none, so the connector hides the scope-gated tool.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { MCPClient } from "@mastra/mcp";

import { createMockVault } from "../../vault/mock.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { ensureGoogleDriveMcp } from "./connector-spawns.ts";
import type { MeshSpawnContext } from "./slot.ts";

type SpawnSpec = { env?: Record<string, string> };

const created: MCPClient[] = [];
afterEach(() => {
  created.length = 0;
});

function spawnCtx(vault: NimbusVault): MeshSpawnContext {
  return {
    vault,
    sandboxCwd: join(import.meta.dir, "sandbox-root-not-created"),
    logger: {
      warn: () => {},
      info: () => {},
      error: () => {},
      debug: () => {},
    } as unknown as MeshSpawnContext["logger"],
    clearLazyIdle: () => {},
    getLazyClient: () => undefined,
    setLazyClient: (_key, client) => {
      created.push(client);
    },
    bumpToolsEpoch: () => {},
    scheduleLazyDisconnect: () => {},
  };
}

async function sharedGoogleVault(scopes: string[] | undefined): Promise<NimbusVault> {
  const vault = createMockVault();
  await vault.set(
    "google.oauth",
    JSON.stringify({
      accessToken: "tok",
      refreshToken: "ref",
      expiresAt: Date.now() + 3_600_000,
      ...(scopes === undefined ? {} : { scopes }),
    }),
  );
  return vault;
}

function servers(): Record<string, SpawnSpec> {
  expect(created).toHaveLength(1);
  // The real client keeps its specs on `serverConfigs`; the process-global mock other files install
  // keeps them on `servers`. Read whichever is present (as github-spawn-env.test.ts does).
  const c = created[0] as unknown as {
    serverConfigs?: Record<string, SpawnSpec>;
    servers?: Record<string, SpawnSpec>;
  };
  const specs = c.serverConfigs ?? c.servers;
  if (specs === undefined) throw new Error("the spawned MCP client exposes no server specs");
  return specs;
}

describe("ensureGoogleDriveMcp passes the token's scopes to Gmail only", () => {
  test("with scopes stored: Gmail gets GOOGLE_OAUTH_SCOPES, the others do not", async () => {
    const scopes = [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.modify",
    ];
    await ensureGoogleDriveMcp(spawnCtx(await sharedGoogleVault(scopes)));
    const s = servers();
    expect(Object.keys(s).sort()).toEqual([
      "gmail",
      "google_drive",
      "google_meet",
      "google_photos",
    ]);
    expect(s["gmail"]?.env?.["GOOGLE_OAUTH_SCOPES"]).toBe(scopes.join(" "));
    for (const id of ["google_drive", "google_photos", "google_meet"]) {
      expect(Object.hasOwn(s[id]?.env ?? {}, "GOOGLE_OAUTH_SCOPES"), id).toBe(false);
      expect(s[id]?.env?.["GOOGLE_OAUTH_ACCESS_TOKEN"], id).toBe("tok");
    }
    expect(s["gmail"]?.env?.["GOOGLE_OAUTH_ACCESS_TOKEN"]).toBe("tok");
  });

  test("a token without modify passes its own (narrower) scopes, so the connector hides the archive tool", async () => {
    await ensureGoogleDriveMcp(
      spawnCtx(await sharedGoogleVault(["https://www.googleapis.com/auth/gmail.readonly"])),
    );
    expect(servers()["gmail"]?.env?.["GOOGLE_OAUTH_SCOPES"]).toBe(
      "https://www.googleapis.com/auth/gmail.readonly",
    );
  });

  test("a credential that records no scopes passes none", async () => {
    await ensureGoogleDriveMcp(spawnCtx(await sharedGoogleVault(undefined)));
    expect(Object.hasOwn(servers()["gmail"]?.env ?? {}, "GOOGLE_OAUTH_SCOPES")).toBe(false);
  });
});

describe("google_calendar is own-key-only at the bundle", () => {
  test("a shared google.oauth does NOT start the google_calendar server (see the 4-server pin above)", async () => {
    await ensureGoogleDriveMcp(spawnCtx(await sharedGoogleVault(undefined)));
    expect(Object.keys(servers())).not.toContain("google_calendar");
  });

  test("its own key starts it with an access token and no scopes", async () => {
    const vault = await sharedGoogleVault(undefined);
    await vault.set(
      "google_calendar.oauth",
      JSON.stringify({ accessToken: "cal", refreshToken: "ref", expiresAt: Date.now() + 3_600_000 }),
    );
    await ensureGoogleDriveMcp(spawnCtx(vault));
    const s = servers();
    expect(Object.keys(s)).toContain("google_calendar");
    expect(s["google_calendar"]?.env?.["GOOGLE_OAUTH_ACCESS_TOKEN"]).toBe("cal");
    expect(Object.hasOwn(s["google_calendar"]?.env ?? {}, "GOOGLE_OAUTH_SCOPES")).toBe(false);
  });
});
