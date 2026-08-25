import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import pino from "pino";
import { createPrefectSyncable } from "../../../src/connectors/prefect-sync.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { ProviderRateLimiter } from "../../../src/sync/rate-limiter.ts";
import { buildSyncCapabilities } from "../../../src/sync/sync-capabilities.ts";
import type { SyncContext } from "../../../src/sync/types.ts";
import { createMockVault } from "../../../src/vault/mock.ts";

interface RecordedReq {
  method: string;
  path: string;
  offset: number | null;
  limit: number | null;
  sort: string | null;
  authorization: string | null;
}

interface FakePrefectConfig {
  // Map of offset -> deployments array for that page.
  pages?: Record<string, unknown[]>;
  status?: number;
}

interface FakePrefect {
  baseUrl: string;
  requests: RecordedReq[];
  stop(): void;
}

function startFakePrefect(config: FakePrefectConfig): FakePrefect {
  const requests: RecordedReq[] = [];
  let server: Server | undefined;
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const u = new URL(req.url);
      let offset: number | null = null;
      let limit: number | null = null;
      let sort: string | null = null;
      let bodyJson: Record<string, unknown> = {};
      if (req.method === "POST") {
        try {
          bodyJson = (await req.json()) as Record<string, unknown>;
        } catch {
          bodyJson = {};
        }
        offset = typeof bodyJson["offset"] === "number" ? bodyJson["offset"] : null;
        limit = typeof bodyJson["limit"] === "number" ? bodyJson["limit"] : null;
        sort = typeof bodyJson["sort"] === "string" ? bodyJson["sort"] : null;
      }
      requests.push({
        method: req.method,
        path: u.pathname,
        offset,
        limit,
        sort,
        authorization: req.headers.get("authorization"),
      });
      if (u.pathname !== "/deployments/filter" || req.method !== "POST") {
        return new Response("not found", { status: 404 });
      }
      if (config.status !== undefined && config.status !== 200) {
        return new Response("error", { status: config.status });
      }
      const key = String(offset ?? 0);
      const deployments = config.pages?.[key] ?? [];
      return Response.json(deployments);
    },
  });
  const baseUrl = `http://${server.hostname}:${server.port}`;
  return { baseUrl, requests, stop: () => server?.stop(true) };
}

interface Harness {
  vault: ReturnType<typeof createMockVault>;
  db: Database;
  ctx: SyncContext;
  fake: FakePrefect;
  cleanup: () => void;
}

function startHarness(config: FakePrefectConfig): Harness {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const vault = createMockVault();
  const fake = startFakePrefect(config);
  return {
    db,
    vault,
    fake,
    cleanup: () => {
      fake.stop();
      db.close();
    },
    ctx: {
      ...buildSyncCapabilities({ vault, db, depth: "full" }, "prefect"),
      logger: pino({ level: "silent" }),
      rateLimiter: new ProviderRateLimiter({
        prefect: { requestsPerMinute: 600_000, burstSize: 10_000 },
      }),
    },
  };
}

function deployment(id: string, over: { name?: string; description?: string } = {}): unknown {
  return {
    id,
    name: over.name ?? `deploy_${id}`,
    flow_id: `flow_${id}`,
    description: over.description ?? `desc for ${id}`,
    tags: ["tier-1"],
    paused: false,
    work_pool_name: "default-pool",
    work_queue_name: "default-queue",
    schedules: [{ schedule: { cron: "0 2 * * *" } }],
    status: "READY",
    created: "2026-05-30T12:00:00+00:00",
    updated: "2026-05-31T12:00:00+00:00",
  };
}

// 100 distinct deployments — a full page that triggers a second page fetch.
function fullPage(prefix: string): unknown[] {
  return Array.from({ length: 100 }, (_, i) => deployment(`${prefix}_${String(i)}`));
}

async function setCreds(h: Harness): Promise<void> {
  await h.vault.set("prefect.api_url", h.fake.baseUrl);
  await h.vault.set("prefect.api_key", "pnu_test");
}

describe("prefect-sync against Bun.serve fake API", () => {
  let h: Harness | undefined;
  afterEach(() => {
    h?.cleanup();
    h = undefined;
  });

  test("happy path: lists deployments, upserts rows with Bearer auth, pass-1 cursor", async () => {
    h = startHarness({
      pages: { "0": [deployment("aaa", { name: "nightly-etl" }), deployment("bbb")] },
    });
    await setCreds(h);

    const syncable = createPrefectSyncable({ ensurePrefectMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-prefect1:")).toBe(true);

    for (const r of h.fake.requests) {
      expect(r.authorization).toBe("Bearer pnu_test");
      expect(r.path).toBe("/deployments/filter");
      expect(r.method).toBe("POST");
      expect(r.limit).toBe(100);
      expect(r.sort).toBe("CREATED_DESC");
    }

    const rows = h.db
      .query<{ external_id: string; metadata: string }, []>(
        "SELECT external_id, metadata FROM item WHERE service = 'prefect' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["aaa", "bbb"]);

    const first = JSON.parse(rows[0]?.metadata ?? "{}") as Record<string, unknown>;
    expect(first["deployment_id"]).toBe("aaa");
    expect(first["name"]).toBe("nightly-etl");
    expect(first["work_pool_name"]).toBe("default-pool");
  });

  test("walks multiple pages via the offset body field", async () => {
    h = startHarness({
      pages: {
        "0": fullPage("a"),
        "100": [deployment("b_0"), deployment("b_1")],
      },
    });
    await setCreds(h);

    const syncable = createPrefectSyncable({ ensurePrefectMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(102);
    expect(h.fake.requests.map((r) => r.offset)).toEqual([0, 100]);
  });

  test("short page stops the walk (single request)", async () => {
    h = startHarness({ pages: { "0": [deployment("only")] } });
    await setCreds(h);

    const syncable = createPrefectSyncable({ ensurePrefectMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(1);
    expect(h.fake.requests).toHaveLength(1);
  });

  test("noop when credentials unset — no requests", async () => {
    h = startHarness({ pages: { "0": [deployment("x")] } });
    const syncable = createPrefectSyncable({ ensurePrefectMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("a 429 on page 1 degrades gracefully (no throw, zero upserts, pass-1 cursor)", async () => {
    h = startHarness({ pages: { "0": [deployment("x")] }, status: 429 });
    await setCreds(h);
    const syncable = createPrefectSyncable({ ensurePrefectMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-prefect1:")).toBe(true);
  });

  test("a 401 (auth failure) on page 1 degrades gracefully (no throw, zero upserts)", async () => {
    h = startHarness({ pages: { "0": [deployment("x")] }, status: 401 });
    await h.vault.set("prefect.api_url", h.fake.baseUrl);
    await h.vault.set("prefect.api_key", "bad");
    const syncable = createPrefectSyncable({ ensurePrefectMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-prefect1:")).toBe(true);
  });

  test("a 403 (forbidden) on page 1 degrades gracefully (no throw, zero upserts)", async () => {
    h = startHarness({ pages: { "0": [deployment("x")] }, status: 403 });
    await setCreds(h);
    const syncable = createPrefectSyncable({ ensurePrefectMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-prefect1:")).toBe(true);
  });

  test("empty first page yields zero upserts and pass-1 cursor; single request", async () => {
    h = startHarness({ pages: { "0": [] } });
    await setCreds(h);
    const syncable = createPrefectSyncable({ ensurePrefectMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-prefect1:")).toBe(true);
    expect(h.fake.requests).toHaveLength(1);
  });
});
