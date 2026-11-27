import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import pino from "pino";
import {
  createSplitSyncable,
  SPLIT_MAX_PAGES_PER_WORKSPACE,
} from "../../../src/connectors/split-sync.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { ProviderRateLimiter } from "../../../src/sync/rate-limiter.ts";
import { buildSyncCapabilities } from "../../../src/sync/sync-capabilities.ts";
import type { SyncContext } from "../../../src/sync/types.ts";
import { createMockVault } from "../../../src/vault/mock.ts";
import { requestUrl } from "../../helpers/request-url.ts";

interface RecordedReq {
  path: string;
  auth: string | null;
  search: URLSearchParams;
}

interface FakeConfig {
  workspaces: Array<{ id: string; name: string }>;
  splitsByWorkspace: Record<string, unknown[]>;
  /** Report a totalCount (the default) or leave it out. */
  withTotal?: boolean;
  workspacesStatus?: number;
}

interface Harness {
  vault: ReturnType<typeof createMockVault>;
  db: Database;
  ctx: SyncContext;
  requests: RecordedReq[];
  cleanup: () => void;
}

function startHarness(config: FakeConfig): Harness {
  const requests: RecordedReq[] = [];
  const server: Server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const u = new URL(req.url);
      requests.push({
        path: u.pathname,
        auth: req.headers.get("authorization"),
        search: u.searchParams,
      });
      if (u.pathname === "/internal/api/v2/workspaces") {
        if (config.workspacesStatus !== undefined) {
          return new Response("error", { status: config.workspacesStatus });
        }
        return Response.json({
          objects: config.workspaces,
          offset: 0,
          limit: 20,
          totalCount: config.workspaces.length,
        });
      }
      const m = /^\/internal\/api\/v2\/splits\/ws\/([^/]+)$/.exec(u.pathname);
      if (m !== null) {
        const all = config.splitsByWorkspace[decodeURIComponent(m[1] ?? "")] ?? [];
        const offset = Number(u.searchParams.get("offset") ?? "0");
        const limit = Number(u.searchParams.get("limit") ?? "50");
        return Response.json({
          objects: all.slice(offset, offset + limit),
          offset,
          limit,
          ...(config.withTotal === false ? {} : { totalCount: all.length }),
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const vault = createMockVault();
  const originalFetch = globalThis.fetch;
  const fakeBase = `http://${server.hostname}:${String(server.port)}`;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    originalFetch(
      requestUrl(input).replace("https://api.split.io", fakeBase),
      init,
    )) as typeof fetch;
  return {
    vault,
    db,
    requests,
    cleanup: () => {
      globalThis.fetch = originalFetch;
      server.stop(true);
      db.close();
    },
    ctx: {
      ...buildSyncCapabilities({ vault, db, depth: "full" }, "split"),
      logger: pino({ level: "silent" }),
      rateLimiter: new ProviderRateLimiter({
        split: { requestsPerMinute: 600_000, burstSize: 10_000 },
      }),
    },
  };
}

function split(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `id-${name}`,
    name,
    description: `Split ${name}`,
    trafficType: { id: "tt", name: "user" },
    creationTime: 1_700_000_000_000,
    rolloutStatus: { id: "rs", name: "Ramping" },
    tags: [{ name: "checkout" }, { name: "beta" }],
    ...over,
  };
}

const syncable = () => createSplitSyncable({ ensureSplitMcpRunning: async () => {} });

describe("split-sync against a Bun.serve fake Admin API", () => {
  let h: Harness | undefined;
  afterEach(() => {
    h?.cleanup();
    h = undefined;
  });

  test("walks workspaces then pages of splits with Bearer auth, indexing definitions only", async () => {
    h = startHarness({
      workspaces: [{ id: "ws-1", name: "Default" }],
      splitsByWorkspace: { "ws-1": [split("new_checkout"), split("dark_mode")] },
    });
    await h.vault.set("split.api_key", "fake-split-key");
    const result = await syncable().sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(2);
    expect(result.cursor?.startsWith("nimbus-split1:")).toBe(true);
    for (const r of h.requests) expect(r.auth).toBe("Bearer fake-split-key");
    const got = h.db
      .query<{ external_id: string; metadata: string }, []>(
        "SELECT external_id, metadata FROM item WHERE service = 'split' ORDER BY external_id",
      )
      .all();
    expect(got.map((r) => r.external_id)).toEqual(["ws-1:dark_mode", "ws-1:new_checkout"]);
    const m = JSON.parse(got[1]?.metadata ?? "{}") as Record<string, unknown>;
    expect(m["workspace_name"]).toBe("Default");
    expect(m["traffic_type"]).toBe("user");
    expect(m["rollout_status"]).toBe("Ramping");
    expect(m["tags"]).toEqual(["beta", "checkout"]);
    expect(m["created_at"]).toBe(1_700_000_000_000);
    expect(m["killed"]).toBeUndefined();
  });

  test("pages by offset until the total, and stops at the page cap", async () => {
    const many = Array.from({ length: 120 }, (_, i) => split(`s${String(i)}`));
    h = startHarness({
      workspaces: [{ id: "ws-1", name: "W" }],
      splitsByWorkspace: { "ws-1": many },
    });
    await h.vault.set("split.api_key", "fake-split-key");
    expect((await syncable().sync(h.ctx, null)).itemsUpserted).toBe(120);
    const pages = h.requests.filter((r) => r.path.startsWith("/internal/api/v2/splits/"));
    expect(pages.map((r) => r.search.get("offset"))).toEqual(["0", "50", "100"]);

    h.cleanup();
    const huge = Array.from({ length: 50 * (SPLIT_MAX_PAGES_PER_WORKSPACE + 1) }, (_, i) =>
      split(`s${String(i)}`),
    );
    h = startHarness({
      workspaces: [{ id: "ws-1", name: "W" }],
      splitsByWorkspace: { "ws-1": huge },
      withTotal: false,
    });
    await h.vault.set("split.api_key", "fake-split-key");
    expect((await syncable().sync(h.ctx, null)).itemsUpserted).toBe(
      50 * SPLIT_MAX_PAGES_PER_WORKSPACE,
    );
  });

  test("an error on the workspace list upserts nothing; no key sends no request", async () => {
    h = startHarness({ workspaces: [], splitsByWorkspace: {}, workspacesStatus: 401 });
    expect((await syncable().sync(h.ctx, "c")).cursor).toBe("c");
    expect(h.requests).toHaveLength(0);
    await h.vault.set("split.api_key", "fake-split-key");
    const result = await syncable().sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-split1:")).toBe(true);
  });
});
