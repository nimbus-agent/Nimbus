import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import pino from "pino";
import { createDbtSyncable } from "../../../src/connectors/dbt-sync.ts";
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

interface FakeAccount {
  id: number;
  name: string;
}

interface FakeDbtConfig {
  accounts: FakeAccount[];
  jobsByAccount: Record<string, unknown[]>;
  jobsStatus?: number;
}

interface FakeDbt {
  apiBase: string;
  requests: RecordedReq[];
  stop(): void;
}

function startFakeDbt(config: FakeDbtConfig): FakeDbt {
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
      if (u.pathname === "/api/v2/accounts/") {
        return Response.json({ data: config.accounts });
      }
      const jobsMatch = /^\/api\/v2\/accounts\/([^/]+)\/jobs\/$/.exec(u.pathname);
      if (jobsMatch !== null) {
        if (config.jobsStatus !== undefined && config.jobsStatus !== 200) {
          return new Response("error", { status: config.jobsStatus });
        }
        const accountId = decodeURIComponent(jobsMatch[1] ?? "");
        const all = config.jobsByAccount[accountId] ?? [];
        const limit = Number.parseInt(u.searchParams.get("limit") ?? "100", 10);
        const offset = Number.parseInt(u.searchParams.get("offset") ?? "0", 10);
        const slice = all.slice(offset, offset + limit);
        return Response.json({
          data: slice,
          extra: { pagination: { total_count: all.length, count: slice.length } },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const apiBase = `http://${server.hostname}:${server.port}`;
  return { apiBase, requests, stop: () => server?.stop(true) };
}

interface Harness {
  vault: ReturnType<typeof createMockVault>;
  db: Database;
  ctx: SyncContext;
  fake: FakeDbt;
  cleanup: () => void;
}

function startHarness(config: FakeDbtConfig): Harness {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const vault = createMockVault();
  const fake = startFakeDbt(config);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    const rewritten = url.replace("https://cloud.getdbt.com", fake.apiBase);
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
      ...buildSyncCapabilities({ vault, db, depth: "full" }, "dbt"),
      logger: pino({ level: "silent" }),
      rateLimiter: new ProviderRateLimiter({
        dbt: { requestsPerMinute: 600_000, burstSize: 10_000 },
      }),
    },
  };
}

function dbtJob(id: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `job-${String(id)}`,
    account_id: 42,
    project_id: 77,
    environment_id: 5,
    dbt_version: "1.7.4",
    state: 1,
    schedule: { cron: "0 6 * * *" },
    triggers: { schedule: true },
    created_at: "2021-02-10T20:03:11.000000Z",
    updated_at: "2022-03-15T08:30:00.000000Z",
    ...over,
  };
}

describe("dbt-sync against Bun.serve fake API", () => {
  let h: Harness | undefined;
  afterEach(() => {
    h?.cleanup();
    h = undefined;
  });

  test("walks accounts → jobs and upserts well-formed rows with Token auth", async () => {
    h = startHarness({
      accounts: [{ id: 42, name: "acme" }],
      jobsByAccount: { "42": [dbtJob(1234), dbtJob(5678)] },
    });
    await h.vault.set("dbt.token", "dbt-test-token");

    const syncable = createDbtSyncable({ ensureDbtMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-dbt1:")).toBe(true);

    for (const r of h.fake.requests) {
      expect(r.auth).toBe("Token dbt-test-token");
    }
    expect(h.fake.requests.filter((r) => r.path === "/api/v2/accounts/")).toHaveLength(1);

    const rows = h.db
      .query<{ external_id: string; metadata: string }, []>(
        "SELECT external_id, metadata FROM item WHERE service = 'dbt' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["42:1234", "42:5678"]);
    const a = JSON.parse(rows[0]?.metadata ?? "{}") as Record<string, unknown>;
    expect(a["job_id"]).toBe(1234);
    expect(a["project_id"]).toBe(77);
    expect(a["state"]).toBe("active");
    expect(a["canonical_url"]).toBe("https://cloud.getdbt.com/deploy/42/projects/77/jobs/1234");
  });

  test("dbt.account_id set → skips the /accounts/ round-trip", async () => {
    h = startHarness({
      accounts: [{ id: 42, name: "acme" }],
      jobsByAccount: { "99": [dbtJob(1, { account_id: 99 })] },
    });
    await h.vault.set("dbt.token", "tok");
    await h.vault.set("dbt.account_id", "99");

    const syncable = createDbtSyncable({ ensureDbtMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(1);
    expect(h.fake.requests.filter((r) => r.path === "/api/v2/accounts/")).toHaveLength(0);
    expect(h.fake.requests.some((r) => r.path === "/api/v2/accounts/99/jobs/")).toBe(true);

    const row = h.db
      .query<{ external_id: string }, []>("SELECT external_id FROM item WHERE service = 'dbt'")
      .get();
    expect(row?.external_id).toBe("99:1");
  });

  test("noop when dbt.token is unset — no requests", async () => {
    h = startHarness({ accounts: [], jobsByAccount: {} });
    const syncable = createDbtSyncable({ ensureDbtMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("a 5xx on the jobs endpoint degrades gracefully (no throw, zero upserts, pass-1 cursor)", async () => {
    h = startHarness({
      accounts: [{ id: 42, name: "acme" }],
      jobsByAccount: { "42": [dbtJob(1234)] },
      jobsStatus: 503,
    });
    await h.vault.set("dbt.token", "tok");
    const syncable = createDbtSyncable({ ensureDbtMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-dbt1:")).toBe(true);
  });

  test("a 429 on the jobs endpoint degrades gracefully (no throw, zero upserts)", async () => {
    h = startHarness({
      accounts: [{ id: 42, name: "acme" }],
      jobsByAccount: { "42": [dbtJob(1234)] },
      jobsStatus: 429,
    });
    await h.vault.set("dbt.token", "tok");
    const syncable = createDbtSyncable({ ensureDbtMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-dbt1:")).toBe(true);
  });

  test("a full page of exactly 100 jobs triggers a second offset page", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => dbtJob(i + 1));
    const extra = [dbtJob(101)];
    h = startHarness({
      accounts: [{ id: 42, name: "acme" }],
      jobsByAccount: { "42": [...fullPage, ...extra] },
    });
    await h.vault.set("dbt.token", "tok");
    const syncable = createDbtSyncable({ ensureDbtMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(101);
    const jobCalls = h.fake.requests.filter((r) => r.path === "/api/v2/accounts/42/jobs/");
    expect(jobCalls.length).toBeGreaterThanOrEqual(2);
    expect(jobCalls[0]?.search.get("offset")).toBe("0");
    expect(jobCalls[1]?.search.get("offset")).toBe("100");
  });
});
