/**
 * End-to-end tests for the bearer-authed HTTP API routes mounted INLINE in the `fetch` handler,
 * ahead of the unauthenticated GET table (http-server.ts's `if (req.method === "GET")` block that
 * already intercepts `BRIEF_GET_RE` / `/v1/agents` / `AGENT_RUN_GET_RE`) — `GET /v1/items/resolve`
 * today.
 *
 * `startServerWithClipToken` is the SHARED harness for this file, modelled on
 * `agent-runs/agent-test-server.ts`: a fresh temp-dir SQLite DB migrated to the latest schema, an
 * in-memory vault seeded with exactly one token minted with the caller's chosen scopes, and a real
 * `startReadOnlyHttpServer` on an OS-assigned port. Extend it (an optional `extraOpts` bag) rather
 * than adding a second parallel helper when a later task needs another server option wired in.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiScope } from "../src/clips/api-scopes.ts";
import { addApiToken, generateClipToken } from "../src/clips/clip-token-store.ts";
import { upsertIndexedItem } from "../src/index/item-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../src/index/local-index.ts";
import { runIndexedSchemaMigrations } from "../src/index/migrations/runner.ts";
import type {
  ReadOnlyHttpServerHandle,
  ReadOnlyHttpServerOptions,
} from "../src/ipc/http-server.ts";
import { startReadOnlyHttpServer } from "../src/ipc/http-server.ts";
import type { NimbusVault } from "../src/vault/nimbus-vault.ts";

function makeInMemoryVault(): NimbusVault {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => {
      store.set(k, v);
    },
    delete: async (k: string) => {
      store.delete(k);
    },
    listKeys: async (prefix?: string) => {
      const keys = [...store.keys()];
      return prefix === undefined ? keys : keys.filter((k) => k.startsWith(prefix));
    },
  };
}

export type ClipTestServer = {
  readonly baseUrl: string;
  readonly token: string;
  readonly db: Database;
  stop(): void;
};

/**
 * Boots a real server with exactly one clip token minted with `scopes`. `extraOpts` is spread
 * over `{ clipsVault }` so a later task can wire in another server option (e.g. `fetchItem`)
 * without a second helper.
 */
export async function startServerWithClipToken(
  scopes: readonly ApiScope[],
  extraOpts: Partial<ReadOnlyHttpServerOptions> = {},
): Promise<ClipTestServer> {
  const tmpDir = mkdtempSync(join(tmpdir(), "nimbus-http-api-e2e-"));
  const dbPath = join(tmpDir, "nimbus.db");

  // Migrate + close, then reopen writable — the server opens its own readonly + (conditionally)
  // writable handles on `dbPath`, so the setup connection must not linger (same pattern as
  // agent-runs/agent-test-server.ts).
  const setupDb = new Database(dbPath);
  runIndexedSchemaMigrations(setupDb, CURRENT_SCHEMA_VERSION);
  setupDb.close();
  const db = new Database(dbPath, { create: false, readwrite: true });

  const token = generateClipToken();
  const vault = makeInMemoryVault();
  await addApiToken(vault, "http-api-e2e-harness", token, scopes);

  const handle: ReadOnlyHttpServerHandle = startReadOnlyHttpServer(dbPath, 0, {
    clipsVault: vault,
    ...extraOpts,
  });

  return {
    baseUrl: `http://127.0.0.1:${handle.port}`,
    token,
    db,
    stop(): void {
      try {
        handle.stop();
      } catch {
        /* ignore */
      }
      try {
        db.close();
      } catch {
        /* ignore */
      }
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

describe("GET /v1/items/resolve", () => {
  test("returns an exact match for a resolve-scoped token", async () => {
    const { baseUrl, token, db, stop } = await startServerWithClipToken(["resolve"]);
    try {
      upsertIndexedItem(db, {
        service: "github",
        type: "pull_request",
        externalId: "pr-1",
        title: "PR one",
        bodyPreview: "x",
        url: "https://github.com/o/r/pull/1",
        canonicalUrl: "https://github.com/o/r/pull/1",
        modifiedAt: 99,
        syncedAt: 99,
      });
      const res = await fetch(
        `${baseUrl}/v1/items/resolve?url=${encodeURIComponent("https://github.com/o/r/pull/1?tab=files")}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        found: true,
        matchKind: "query_stripped",
        item: { id: "github:pr-1", service: "github", type: "pull_request", modified_at: 99 },
      });
    } finally {
      stop();
    }
  });

  test("403s a legacy-scoped token", async () => {
    const { baseUrl, token, stop } = await startServerWithClipToken(["clip", "briefs"]);
    try {
      const res = await fetch(`${baseUrl}/v1/items/resolve?url=https%3A%2F%2Fgithub.com%2Fo%2Fr`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "insufficient_scope", required: "resolve" });
    } finally {
      stop();
    }
  });

  test("401s an unknown token", async () => {
    const { baseUrl, stop } = await startServerWithClipToken(["resolve"]);
    try {
      const res = await fetch(`${baseUrl}/v1/items/resolve?url=https%3A%2F%2Fgithub.com%2Fo%2Fr`, {
        headers: { authorization: "Bearer nope" },
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    } finally {
      stop();
    }
  });

  test("400s a missing url param", async () => {
    const { baseUrl, token, stop } = await startServerWithClipToken(["resolve"]);
    try {
      const res = await fetch(`${baseUrl}/v1/items/resolve`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "missing_url" });
    } finally {
      stop();
    }
  });
});
