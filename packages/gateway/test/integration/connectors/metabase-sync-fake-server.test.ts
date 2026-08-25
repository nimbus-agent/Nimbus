import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import pino from "pino";
import { createMetabaseSyncable } from "../../../src/connectors/metabase-sync.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { ProviderRateLimiter } from "../../../src/sync/rate-limiter.ts";
import { buildSyncCapabilities } from "../../../src/sync/sync-capabilities.ts";
import type { SyncContext } from "../../../src/sync/types.ts";
import { createMockVault } from "../../../src/vault/mock.ts";

interface RecordedReq {
  method: string;
  path: string;
  apiKey: string | null;
}

interface FakeMbConfig {
  dashboards: unknown[];
  collections?: unknown[];
  dashboardsStatus?: number;
  collectionsStatus?: number;
}

interface FakeMb {
  baseUrl: string;
  requests: RecordedReq[];
  stop(): void;
}

function startFakeMb(config: FakeMbConfig): FakeMb {
  const requests: RecordedReq[] = [];
  let server: Server | undefined;
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const u = new URL(req.url);
      requests.push({
        method: req.method,
        path: u.pathname,
        apiKey: req.headers.get("x-api-key"),
      });
      if (u.pathname === "/api/collection") {
        if (config.collectionsStatus !== undefined && config.collectionsStatus !== 200) {
          return new Response("error", { status: config.collectionsStatus });
        }
        return Response.json(config.collections ?? []);
      }
      if (u.pathname === "/api/dashboard") {
        if (config.dashboardsStatus !== undefined && config.dashboardsStatus !== 200) {
          return new Response("error", { status: config.dashboardsStatus });
        }
        return Response.json(config.dashboards);
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
  fake: FakeMb;
  cleanup: () => void;
}

function startHarness(config: FakeMbConfig): Harness {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const vault = createMockVault();
  const fake = startFakeMb(config);
  return {
    db,
    vault,
    fake,
    cleanup: () => {
      fake.stop();
      db.close();
    },
    ctx: {
      ...buildSyncCapabilities({ vault, db, depth: "full" }, "metabase"),
      logger: pino({ level: "silent" }),
      rateLimiter: new ProviderRateLimiter({
        metabase: { requestsPerMinute: 600_000, burstSize: 10_000 },
      }),
    },
  };
}

function dashboard(
  id: number,
  over: { name?: string; description?: string; collection_id?: unknown } = {},
): Record<string, unknown> {
  return {
    id,
    name: over.name ?? `dash-${String(id)}`,
    description: over.description ?? "",
    collection_id: "collection_id" in over ? over.collection_id : 7,
    creator_id: 3,
    archived: false,
    created_at: "2021-02-10T20:03:11Z",
    updated_at: "2022-06-01T08:00:00Z",
    dashcards: [{ id: 1 }],
  };
}

describe("metabase-sync against Bun.serve fake API", () => {
  let h: Harness | undefined;
  afterEach(() => {
    h?.cleanup();
    h = undefined;
  });

  test("happy path: lists dashboards, resolves collection_name, upserts rows with x-api-key", async () => {
    h = startHarness({
      collections: [{ id: 7, name: "Finance" }],
      dashboards: [
        dashboard(10, { name: "Revenue", collection_id: 7 }),
        dashboard(20, { name: "Funnel", collection_id: 7 }),
      ],
    });
    await h.vault.set("metabase.url", h.fake.baseUrl);
    await h.vault.set("metabase.api_key", "mb-key-test");

    const syncable = createMetabaseSyncable({ ensureMetabaseMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-metabase1:")).toBe(true);

    for (const r of h.fake.requests) {
      expect(r.apiKey).toBe("mb-key-test");
    }

    const rows = h.db
      .query<{ external_id: string; metadata: string }, []>(
        "SELECT external_id, metadata FROM item WHERE service = 'metabase' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["10", "20"]);

    const first = JSON.parse(rows[0]?.metadata ?? "{}") as Record<string, unknown>;
    expect(first["dashboard_id"]).toBe(10);
    expect(first["collection_name"]).toBe("Finance");
  });

  test("noop when api_key + url unset — no requests", async () => {
    h = startHarness({ dashboards: [dashboard(1)] });
    const syncable = createMetabaseSyncable({ ensureMetabaseMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("a 5xx on /api/dashboard degrades gracefully (no throw, zero upserts, pass-1 cursor)", async () => {
    h = startHarness({
      collections: [{ id: 7, name: "Finance" }],
      dashboards: [dashboard(1)],
      dashboardsStatus: 503,
    });
    await h.vault.set("metabase.url", h.fake.baseUrl);
    await h.vault.set("metabase.api_key", "k");
    const syncable = createMetabaseSyncable({ ensureMetabaseMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-metabase1:")).toBe(true);
  });

  test("a 429 on /api/dashboard degrades gracefully (no throw, zero upserts, pass-1 cursor)", async () => {
    h = startHarness({
      collections: [{ id: 7, name: "Finance" }],
      dashboards: [dashboard(1)],
      dashboardsStatus: 429,
    });
    await h.vault.set("metabase.url", h.fake.baseUrl);
    await h.vault.set("metabase.api_key", "k");
    const syncable = createMetabaseSyncable({ ensureMetabaseMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-metabase1:")).toBe(true);
  });

  test("a non-ok /api/collection is non-fatal: dashboards still index, collection_name null", async () => {
    h = startHarness({
      collectionsStatus: 500,
      dashboards: [dashboard(10, { name: "Revenue", collection_id: 7 })],
    });
    await h.vault.set("metabase.url", h.fake.baseUrl);
    await h.vault.set("metabase.api_key", "k");
    const syncable = createMetabaseSyncable({ ensureMetabaseMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(1);

    const row = h.db
      .query<{ metadata: string }, []>("SELECT metadata FROM item WHERE external_id = '10'")
      .get();
    const m = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(m["collection_id"]).toBe("7");
    expect(m["collection_name"]).toBeNull();
  });
});
