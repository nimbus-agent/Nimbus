import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import pino from "pino";
import { createDatabricksSyncable } from "../../../src/connectors/databricks-sync.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { ProviderRateLimiter } from "../../../src/sync/rate-limiter.ts";
import { buildSyncCapabilities } from "../../../src/sync/sync-capabilities.ts";
import type { SyncContext } from "../../../src/sync/types.ts";
import { createMockVault } from "../../../src/vault/mock.ts";

interface RecordedReq {
  method: string;
  path: string;
  query: string;
  authorization: string | null;
}

interface JobsPage {
  jobs: unknown[];
  has_more?: boolean;
  next_page_token?: string;
}

interface FakeDbxConfig {
  runs?: unknown[];
  runsStatus?: number;
  jobsPages?: Record<string, JobsPage>;
  jobsStatus?: number;
}

interface FakeDbx {
  baseUrl: string;
  requests: RecordedReq[];
  stop(): void;
}

function startFakeDbx(config: FakeDbxConfig): FakeDbx {
  const requests: RecordedReq[] = [];
  let server: Server | undefined;
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const u = new URL(req.url);
      requests.push({
        method: req.method,
        path: u.pathname,
        query: u.search,
        authorization: req.headers.get("authorization"),
      });
      if (u.pathname === "/api/2.1/jobs/runs/list") {
        if (config.runsStatus !== undefined && config.runsStatus !== 200) {
          return new Response("error", { status: config.runsStatus });
        }
        return Response.json({ runs: config.runs ?? [] });
      }
      if (u.pathname === "/api/2.1/jobs/list") {
        if (config.jobsStatus !== undefined && config.jobsStatus !== 200) {
          return new Response("error", { status: config.jobsStatus });
        }
        const token = u.searchParams.get("page_token") ?? "";
        const page = config.jobsPages?.[token] ?? { jobs: [] };
        return Response.json(page);
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
  fake: FakeDbx;
  cleanup: () => void;
}

function startHarness(config: FakeDbxConfig): Harness {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const vault = createMockVault();
  const fake = startFakeDbx(config);
  return {
    db,
    vault,
    fake,
    cleanup: () => {
      fake.stop();
      db.close();
    },
    ctx: {
      ...buildSyncCapabilities({ vault, db, depth: "full" }, "databricks"),
      logger: pino({ level: "silent" }),
      rateLimiter: new ProviderRateLimiter({
        databricks: { requestsPerMinute: 600_000, burstSize: 10_000 },
      }),
    },
  };
}

function job(
  jobId: number,
  over: { name?: string; creator?: string; created_time?: number } = {},
): Record<string, unknown> {
  return {
    job_id: jobId,
    creator_user_name: over.creator ?? "alice@acme.com",
    created_time: over.created_time ?? 1_613_001_791_000,
    settings: {
      name: over.name ?? `job-${String(jobId)}`,
      format: "MULTI_TASK",
      schedule: { quartz_cron_expression: "0 0 6 * * ?", timezone_id: "UTC" },
    },
  };
}

function run(jobId: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: jobId * 10,
    job_id: jobId,
    start_time: 1_699_900_000_000,
    run_duration: 12_345,
    creator_user_name: "scheduler@acme.com",
    cluster_instance: { cluster_id: `cl-${String(jobId)}` },
    state: { life_cycle_state: "TERMINATED", result_state: "SUCCESS" },
    ...over,
  };
}

describe("databricks-sync against Bun.serve fake API", () => {
  let h: Harness | undefined;
  afterEach(() => {
    h?.cleanup();
    h = undefined;
  });

  test("happy path: 2 jobs enriched from runs → 2 upserts with Bearer auth + job_<id> external_id", async () => {
    h = startHarness({
      runs: [
        run(10),
        run(20, { state: { life_cycle_state: "TERMINATED", result_state: "FAILED" } }),
      ],
      jobsPages: { "": { jobs: [job(10, { name: "Revenue ETL" }), job(20)], has_more: false } },
    });
    await h.vault.set("databricks.host", h.fake.baseUrl);
    await h.vault.set("databricks.token", "dapi-test-token");

    const syncable = createDatabricksSyncable({ ensureDatabricksMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-databricks1:")).toBe(true);

    for (const r of h.fake.requests) {
      expect(r.authorization).toBe("Bearer dapi-test-token");
    }

    const rows = h.db
      .query<{ external_id: string; metadata: string }, []>(
        "SELECT external_id, metadata FROM item WHERE service = 'databricks' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["job_10", "job_20"]);

    const first = JSON.parse(rows[0]?.metadata ?? "{}") as Record<string, unknown>;
    expect(first["job_id"]).toBe(10);
    expect(first["name"]).toBe("Revenue ETL");
    expect(first["latest_run_status"]).toBe("TERMINATED/SUCCESS");

    const second = JSON.parse(rows[1]?.metadata ?? "{}") as Record<string, unknown>;
    expect(second["latest_run_status"]).toBe("TERMINATED/FAILED");
  });

  test("noop when host + token unset — no requests", async () => {
    h = startHarness({ jobsPages: { "": { jobs: [job(1)] } } });
    const syncable = createDatabricksSyncable({ ensureDatabricksMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("a 5xx on /jobs/list (first page) degrades gracefully (no throw, zero upserts, pass-1 cursor)", async () => {
    h = startHarness({
      runs: [run(1)],
      jobsPages: { "": { jobs: [job(1)] } },
      jobsStatus: 503,
    });
    await h.vault.set("databricks.host", h.fake.baseUrl);
    await h.vault.set("databricks.token", "t");
    const syncable = createDatabricksSyncable({ ensureDatabricksMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-databricks1:")).toBe(true);
  });

  test("a non-ok /jobs/runs/list is non-fatal: jobs still index, latest_run_* null", async () => {
    h = startHarness({
      runsStatus: 500,
      jobsPages: { "": { jobs: [job(10, { name: "Revenue ETL" })], has_more: false } },
    });
    await h.vault.set("databricks.host", h.fake.baseUrl);
    await h.vault.set("databricks.token", "t");
    const syncable = createDatabricksSyncable({ ensureDatabricksMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(1);

    const row = h.db
      .query<{ metadata: string }, []>("SELECT metadata FROM item WHERE external_id = 'job_10'")
      .get();
    const m = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(m["name"]).toBe("Revenue ETL");
    expect(m["latest_run_status"]).toBeNull();
    expect(m["latest_run_id"]).toBeNull();
  });

  test("token pagination: has_more + next_page_token triggers a second page_token request", async () => {
    h = startHarness({
      runs: [],
      jobsPages: {
        "": { jobs: [job(1)], has_more: true, next_page_token: "PAGE2" },
        PAGE2: { jobs: [job(2)], has_more: false },
      },
    });
    await h.vault.set("databricks.host", h.fake.baseUrl);
    await h.vault.set("databricks.token", "t");
    const syncable = createDatabricksSyncable({ ensureDatabricksMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(2);

    const jobsListReqs = h.fake.requests.filter((r) => r.path === "/api/2.1/jobs/list");
    expect(jobsListReqs).toHaveLength(2);
    expect(jobsListReqs[1]?.query).toContain("page_token=PAGE2");
  });
});
