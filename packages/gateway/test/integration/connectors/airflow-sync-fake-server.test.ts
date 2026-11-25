import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import pino from "pino";
import { createAirflowSyncable } from "../../../src/connectors/airflow-sync.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { ProviderRateLimiter } from "../../../src/sync/rate-limiter.ts";
import { buildSyncCapabilities } from "../../../src/sync/sync-capabilities.ts";
import type { SyncContext } from "../../../src/sync/types.ts";
import { createMockVault } from "../../../src/vault/mock.ts";

interface RecordedReq {
  method: string;
  path: string;
  offset: string | null;
  limit: string | null;
  authorization: string | null;
}

interface FakeAirflowConfig {
  // Map of offset -> dags array for that page.
  pages?: Record<string, unknown[]>;
  totalEntries?: number;
  status?: number;
  // DAG runs and failed task instances served on the run endpoints (a missing list is an empty one).
  runs?: unknown;
  failedTasks?: unknown[];
  // The run endpoints answer HTTP 500.
  runsFail?: boolean;
}

interface FakeAirflow {
  baseUrl: string;
  requests: RecordedReq[];
  runRequests: RecordedReq[];
  stop(): void;
}

function startFakeAirflow(config: FakeAirflowConfig): FakeAirflow {
  const requests: RecordedReq[] = [];
  const runRequests: RecordedReq[] = [];
  let server: Server | undefined;
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const u = new URL(req.url);
      const isRun = u.pathname.startsWith("/api/v1/dags/~/dagRuns");
      (isRun ? runRequests : requests).push({
        method: req.method,
        path: u.pathname,
        offset: u.searchParams.get("offset"),
        limit: u.searchParams.get("limit"),
        authorization: req.headers.get("authorization"),
      });
      if (isRun) {
        if (config.runsFail === true) return new Response("error", { status: 500 });
        return u.pathname.endsWith("/taskInstances")
          ? Response.json({ task_instances: config.failedTasks ?? [] })
          : Response.json({ dag_runs: config.runs ?? [] });
      }
      if (u.pathname !== "/api/v1/dags") {
        return new Response("not found", { status: 404 });
      }
      if (config.status !== undefined && config.status !== 200) {
        return new Response("error", { status: config.status });
      }
      const offset = u.searchParams.get("offset") ?? "0";
      const dags = config.pages?.[offset] ?? [];
      return Response.json({ dags, total_entries: config.totalEntries ?? dags.length });
    },
  });
  const baseUrl = `http://${server.hostname}:${server.port}`;
  return { baseUrl, requests, runRequests, stop: () => server?.stop(true) };
}

interface Harness {
  vault: ReturnType<typeof createMockVault>;
  db: Database;
  ctx: SyncContext;
  fake: FakeAirflow;
  cleanup: () => void;
}

function startHarness(config: FakeAirflowConfig): Harness {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const vault = createMockVault();
  const fake = startFakeAirflow(config);
  return {
    db,
    vault,
    fake,
    cleanup: () => {
      fake.stop();
      db.close();
    },
    ctx: {
      ...buildSyncCapabilities({ vault, db, depth: "full" }, "airflow"),
      logger: pino({ level: "silent" }),
      rateLimiter: new ProviderRateLimiter({
        airflow: { requestsPerMinute: 600_000, burstSize: 10_000 },
      }),
    },
  };
}

function dag(dagId: string, over: { description?: string; owners?: string[] } = {}): unknown {
  return {
    dag_id: dagId,
    is_paused: false,
    is_active: true,
    owners: over.owners ?? ["data-eng"],
    description: over.description ?? `desc for ${dagId}`,
    schedule_interval: { __type: "CronExpression", value: "0 2 * * *" },
    tags: [{ name: "tier-1" }],
    fileloc: `/opt/airflow/dags/${dagId}.py`,
    next_dagrun: "2026-06-01T02:00:00+00:00",
    last_parsed_time: "2026-05-31T12:00:00+00:00",
  };
}

// 100 distinct DAGs — a full page that triggers a second page fetch.
function fullPage(prefix: string): unknown[] {
  return Array.from({ length: 100 }, (_, i) => dag(`${prefix}_${String(i)}`));
}

async function setCreds(h: Harness): Promise<void> {
  await h.vault.set("airflow.base_url", h.fake.baseUrl);
  await h.vault.set("airflow.username", "admin");
  await h.vault.set("airflow.password", "secret");
}

describe("airflow-sync against Bun.serve fake API", () => {
  let h: Harness | undefined;
  afterEach(() => {
    h?.cleanup();
    h = undefined;
  });

  test("happy path: lists DAGs, upserts rows with Basic auth, pass-1 cursor", async () => {
    h = startHarness({
      pages: { "0": [dag("nightly_etl"), dag("hourly_sync")] },
    });
    await setCreds(h);

    const syncable = createAirflowSyncable({ ensureAirflowMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-airflow1:")).toBe(true);

    const expectedAuth = `Basic ${Buffer.from("admin:secret", "utf8").toString("base64")}`;
    for (const r of h.fake.requests) {
      expect(r.authorization).toBe(expectedAuth);
      expect(r.path).toBe("/api/v1/dags");
      expect(r.limit).toBe("100");
    }

    const rows = h.db
      .query<{ external_id: string; metadata: string }, []>(
        "SELECT external_id, metadata FROM item WHERE service = 'airflow' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["hourly_sync", "nightly_etl"]);

    const first = JSON.parse(rows[1]?.metadata ?? "{}") as Record<string, unknown>;
    expect(first["dag_id"]).toBe("nightly_etl");
    expect(first["schedule_interval"]).toBe("0 2 * * *");
    expect(first["owners"]).toEqual(["data-eng"]);
  });

  test("walks multiple pages via total_entries + offset", async () => {
    h = startHarness({
      pages: {
        "0": fullPage("a"),
        "100": [dag("b_0"), dag("b_1")],
      },
      totalEntries: 102,
    });
    await setCreds(h);

    const syncable = createAirflowSyncable({ ensureAirflowMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(102);
    const offsets = h.fake.requests.map((r) => r.offset);
    expect(offsets).toEqual(["0", "100"]);
  });

  test("stops at total_entries even when the page is full (exact-boundary)", async () => {
    h = startHarness({
      pages: { "0": fullPage("a") },
      totalEntries: 100,
    });
    await setCreds(h);

    const syncable = createAirflowSyncable({ ensureAirflowMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(100);
    // offset (0) + dags.length (100) >= total (100) → only one request.
    expect(h.fake.requests.map((r) => r.offset)).toEqual(["0"]);
  });

  test("noop when credentials unset — no requests", async () => {
    h = startHarness({ pages: { "0": [dag("x")] } });
    const syncable = createAirflowSyncable({ ensureAirflowMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("a 429 on page 1 degrades gracefully (no throw, zero upserts, pass-1 cursor)", async () => {
    h = startHarness({ pages: { "0": [dag("x")] }, status: 429 });
    await setCreds(h);
    const syncable = createAirflowSyncable({ ensureAirflowMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-airflow1:")).toBe(true);
  });

  test("a 401 (auth failure) on page 1 degrades gracefully (no throw, zero upserts)", async () => {
    h = startHarness({ pages: { "0": [dag("x")] }, status: 401 });
    await h.vault.set("airflow.base_url", h.fake.baseUrl);
    await h.vault.set("airflow.username", "admin");
    await h.vault.set("airflow.password", "bad");
    const syncable = createAirflowSyncable({ ensureAirflowMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-airflow1:")).toBe(true);
  });

  test("a 403 (forbidden) on page 1 degrades gracefully (no throw, zero upserts)", async () => {
    h = startHarness({ pages: { "0": [dag("x")] }, status: 403 });
    await setCreds(h);
    const syncable = createAirflowSyncable({ ensureAirflowMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-airflow1:")).toBe(true);
  });

  test("empty first page yields zero upserts and pass-1 cursor; single request", async () => {
    h = startHarness({ pages: { "0": [] }, totalEntries: 0 });
    await setCreds(h);
    const syncable = createAirflowSyncable({ ensureAirflowMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-airflow1:")).toBe(true);
    expect(h.fake.requests).toHaveLength(1);
  });

  test("short first page stops the walk regardless of total_entries", async () => {
    // A non-full first page short-circuits the offset walk even when
    // total_entries claims there is more — one request only.
    h = startHarness({ pages: { "0": [dag("only")] }, totalEntries: 9999 });
    await setCreds(h);
    const syncable = createAirflowSyncable({ ensureAirflowMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(1);
    expect(h.fake.requests).toHaveLength(1);
  });

  test("indexes recent DAG runs as metadata only, with the failed task ids", async () => {
    h = startHarness({
      pages: { "0": [dag("nightly_etl")] },
      runs: [
        {
          dag_id: "nightly_etl",
          dag_run_id: "scheduled__2026-06-01",
          state: "failed",
          start_date: "2026-06-01T02:00:00+00:00",
          end_date: "2026-06-01T02:10:00+00:00",
          run_type: "scheduled",
          conf: { secret_customer_email: "a@example.com" },
        },
        {
          dag_id: "nightly_etl",
          dag_run_id: "manual__1",
          state: "success",
          start_date: "2026-06-01T03:00:00+00:00",
          end_date: "2026-06-01T03:01:00+00:00",
          run_type: "manual",
        },
      ],
      failedTasks: [
        { dag_id: "nightly_etl", dag_run_id: "scheduled__2026-06-01", task_id: "load_orders" },
        { dag_id: "nightly_etl", dag_run_id: "scheduled__2026-06-01", task_id: "dedupe" },
      ],
    });
    await setCreds(h);
    const syncable = createAirflowSyncable({ ensureAirflowMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(3);
    expect(h.fake.runRequests.some((r) => r.path.endsWith("/taskInstances"))).toBe(true);
    const rows = h.db
      .query<{ external_id: string; metadata: string }, []>(
        "SELECT external_id, metadata FROM item WHERE service = 'airflow' AND type = 'dag_run' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual([
      "nightly_etl|manual__1",
      "nightly_etl|scheduled__2026-06-01",
    ]);
    const failed = JSON.parse(rows[1]?.metadata ?? "{}") as Record<string, unknown>;
    expect(failed["parent_item_id"]).toBe("airflow:nightly_etl");
    expect(failed["outcome"]).toBe("failed");
    expect(failed["failed_tasks"]).toEqual(["dedupe", "load_orders"]);
    expect(failed["duration_ms"]).toBe(600_000);
    expect(failed["trigger"]).toBe("scheduled");
    expect(rows[1]?.metadata).not.toContain("secret_customer_email");
  });

  test("a failing run endpoint never fails the DAG sync", async () => {
    h = startHarness({ pages: { "0": [dag("a")] }, runsFail: true });
    await setCreds(h);
    const syncable = createAirflowSyncable({ ensureAirflowMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(1);
    expect(result.cursor?.startsWith("nimbus-airflow1:")).toBe(true);
    expect(h.fake.runRequests.length).toBeGreaterThan(0);
  });

  test("the run walk stops at its page cap", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({
      dag_id: "d",
      dag_run_id: `r${String(i)}`,
      state: "success",
    }));
    h = startHarness({ pages: { "0": [dag("d")] }, runs: full });
    await setCreds(h);
    const syncable = createAirflowSyncable({ ensureAirflowMcpRunning: async () => {} });
    await syncable.sync(h.ctx, null);
    expect(h.fake.runRequests).toHaveLength(5);
  });

  test("malformed failed-task rows and a non-list run reply are skipped, never thrown", async () => {
    h = startHarness({
      pages: { "0": [dag("nightly_etl")] },
      runs: [{ dag_id: "nightly_etl", dag_run_id: "r1", state: "failed" }],
      failedTasks: [
        null,
        { dag_run_id: "r1", task_id: "t" },
        { dag_id: "nightly_etl", task_id: "t" },
        { dag_id: "nightly_etl", dag_run_id: "r1" },
        { dag_id: "nightly_etl", dag_run_id: "r1", task_id: "good" },
      ],
    });
    await setCreds(h);
    const syncable = createAirflowSyncable({ ensureAirflowMcpRunning: async () => {} });
    await syncable.sync(h.ctx, null);
    const row = h.db
      .query<{ metadata: string }, []>(
        "SELECT metadata FROM item WHERE service = 'airflow' AND type = 'dag_run'",
      )
      .get();
    expect((JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>)["failed_tasks"]).toEqual([
      "good",
    ]);
    h.cleanup();

    h = startHarness({ pages: { "0": [dag("a")] }, runs: { oops: true } });
    await setCreds(h);
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(1);
  });
});
