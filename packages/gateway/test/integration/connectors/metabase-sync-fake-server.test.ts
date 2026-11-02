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
  /** Raw `/api/card` body. Omit for a server with no cards route (404). */
  cards?: unknown;
  cardsStatus?: number;
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
      if (u.pathname === "/api/card" && config.cards !== undefined) {
        if (config.cardsStatus !== undefined && config.cardsStatus !== 200) {
          return new Response("error", { status: config.cardsStatus });
        }
        return Response.json(config.cards);
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

function card(id: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `card-${String(id)}`,
    description: "Which months brought in the most revenue?",
    type: "question",
    collection_id: 7,
    dashboard_id: null,
    creator_id: 3,
    archived: false,
    query_type: "native",
    database_id: 1,
    table_id: null,
    created_at: "2021-02-10T20:03:11Z",
    updated_at: "2022-06-01T08:00:00Z",
    dataset_query: {
      "lib/type": "mbql/query",
      database: 1,
      stages: [
        {
          "lib/type": "mbql.stage/native",
          native: "SELECT month, SUM(total) FROM orders GROUP BY month",
          "template-tags": [{ name: "min", default: "TAG-SENTINEL" }],
        },
      ],
    },
    result_metadata: [{ name: "TOTAL", fingerprint: { type: { avg: "RESULT-SENTINEL" } } }],
    ...over,
  };
}

interface ItemRow {
  id: string;
  type: string;
  external_id: string;
  metadata: string;
}

function metabaseItems(db: Database): ItemRow[] {
  return db
    .query<ItemRow, []>(
      "SELECT id, type, external_id, metadata FROM item WHERE service = 'metabase' ORDER BY id",
    )
    .all();
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

  describe("cards", () => {
    async function runSync(config: FakeMbConfig) {
      h = startHarness(config);
      await h.vault.set("metabase.url", h.fake.baseUrl);
      await h.vault.set("metabase.api_key", "k");
      const syncable = createMetabaseSyncable({ ensureMetabaseMcpRunning: async () => {} });
      return { harness: h, result: await syncable.sync(h.ctx, null) };
    }

    test("cards are requested with x-api-key and indexed as metabase:card, with collection_name", async () => {
      const { harness, result } = await runSync({
        collections: [{ id: 7, name: "Finance" }],
        dashboards: [],
        cards: [card(42, { name: "Revenue by month" })],
      });
      expect(result.itemsUpserted).toBe(1);
      const cardReq = harness.fake.requests.find((r) => r.path === "/api/card");
      expect(cardReq?.apiKey).toBe("k");

      const [item] = metabaseItems(harness.db);
      expect(item?.id).toBe("metabase:card/42");
      expect(item?.type).toBe("card");
      const m = JSON.parse(item?.metadata ?? "{}") as Record<string, unknown>;
      expect(m["collection_name"]).toBe("Finance");
      expect(m["native_query"]).toBe("SELECT month, SUM(total) FROM orders GROUP BY month");
    });

    test("collections are fetched once and reused for cards", async () => {
      const { harness } = await runSync({
        collections: [{ id: 7, name: "Finance" }],
        dashboards: [dashboard(1)],
        cards: [card(2)],
      });
      expect(harness.fake.requests.map((r) => r.path)).toEqual([
        "/api/collection",
        "/api/dashboard",
        "/api/card",
      ]);
    });

    test("a { data: [...] } response is read the same as a bare array", async () => {
      const { harness, result } = await runSync({ dashboards: [], cards: { data: [card(42)] } });
      expect(result.itemsUpserted).toBe(1);
      expect(metabaseItems(harness.db).map((i) => i.id)).toEqual(["metabase:card/42"]);
    });

    test("dashboard 7 and card 7 both survive as separate items", async () => {
      const { harness, result } = await runSync({
        dashboards: [dashboard(7)],
        cards: [card(7)],
      });
      expect(result.itemsUpserted).toBe(2);
      expect(metabaseItems(harness.db).map((i) => [i.id, i.type, i.external_id])).toEqual([
        ["metabase:7", "dashboard", "7"],
        ["metabase:card/7", "card", "card/7"],
      ]);
    });

    test("rows with a missing or empty id are skipped", async () => {
      const noId = card(1);
      delete noId["id"];
      const { harness, result } = await runSync({
        dashboards: [],
        cards: [noId, card(2, { id: "" }), card(3)],
      });
      expect(result.itemsUpserted).toBe(1);
      expect(metabaseItems(harness.db).map((i) => i.id)).toEqual(["metabase:card/3"]);
    });

    test("a 500 on /api/card leaves dashboards indexed and the sync successful", async () => {
      const { harness, result } = await runSync({
        dashboards: [dashboard(7)],
        cards: [card(7)],
        cardsStatus: 500,
      });
      expect(result.itemsUpserted).toBe(1);
      expect(result.cursor?.startsWith("nimbus-metabase1:")).toBe(true);
      expect(metabaseItems(harness.db).map((i) => i.id)).toEqual(["metabase:7"]);
    });

    test("a failed /api/dashboard skips cards in that sync", async () => {
      const { harness, result } = await runSync({
        dashboards: [],
        dashboardsStatus: 503,
        cards: [card(7)],
      });
      expect(result.itemsUpserted).toBe(0);
      expect(harness.fake.requests.map((r) => r.path)).not.toContain("/api/card");
    });

    test("no results endpoint is called and no result data is stored", async () => {
      const { harness } = await runSync({
        dashboards: [dashboard(7)],
        cards: [card(7), card(8)],
      });
      expect(harness.fake.requests.every((r) => r.method === "GET")).toBe(true);
      expect([...new Set(harness.fake.requests.map((r) => r.path))].sort()).toEqual([
        "/api/card",
        "/api/collection",
        "/api/dashboard",
      ]);
      const stored = JSON.stringify(metabaseItems(harness.db));
      expect(stored).not.toContain("RESULT-SENTINEL");
      expect(stored).not.toContain("TAG-SENTINEL");
    });
  });
});
