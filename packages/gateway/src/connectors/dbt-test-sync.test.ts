import { expect, test } from "bun:test";
import type { SyncContext } from "../sync/types.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  describeWithFetchRestore,
  type SyncTestFetchParams,
  syncTestContext,
  urlFromFetchInput,
} from "./connector-sync-test-helpers.ts";
import { createDbtSyncable } from "./dbt-sync.ts";
import { MAX_RUNS_PER_PASS } from "./dbt-test-sync.ts";
import { decodeNimbusJsonCursorObject } from "./nimbus-json-cursor.ts";

const NOW = Date.now();
const FAIL_UID = "test.shop.not_null_orders_id.abc";
const SENTINEL = "ROW-VALUE-SENTINEL-77";

function run(id: number, minutesAgo: number, status = 10): Record<string, unknown> {
  return {
    id,
    job_id: 3,
    project_id: 5,
    status,
    finished_at: new Date(NOW - minutesAgo * 60_000).toISOString(),
  };
}
function finishedMs(r: Record<string, unknown>): number {
  return Date.parse(r["finished_at"] as string);
}

const RESULTS = {
  results: [
    {
      unique_id: FAIL_UID,
      status: "fail",
      failures: 3,
      message: SENTINEL,
      compiled_code: SENTINEL,
    },
    { unique_id: "test.shop.ok.def", status: "pass", failures: 0 },
    { unique_id: "model.shop.orders", status: "success" },
  ],
};
const MANIFEST = {
  nodes: {
    [FAIL_UID]: { name: "not_null_orders_id", depends_on: { nodes: ["model.shop.orders"] } },
    "model.shop.orders": {
      resource_type: "model",
      name: "orders",
      database: "ANALYTICS",
      schema: "SALES",
      alias: "orders",
    },
  },
};

function vault() {
  return createStubVault({ "dbt.token": "tok", "dbt.account_id": "42" });
}
function syncable() {
  return createDbtSyncable({ ensureDbtMcpRunning: async () => {} });
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}
function testsCursor(cursor: string | null): Record<string, number> {
  return (decodeNimbusJsonCursorObject(cursor, "nimbus-dbt1:")?.["tests"] ?? {}) as Record<
    string,
    number
  >;
}

type Router = (u: string) => Response | undefined;
function route(extra: Router, calls: string[] = []): typeof fetch {
  return (async (input: SyncTestFetchParams[0]): Promise<Response> => {
    const u = urlFromFetchInput(input);
    calls.push(u);
    return extra(u) ?? json({ data: [] });
  }) as typeof fetch;
}

function testRows(db: ReturnType<typeof createMemoryIndexDb>) {
  return db
    .query("SELECT id, metadata FROM item WHERE service='dbt' AND type='data_quality_test'")
    .all() as { id: string; metadata: string }[];
}

describeWithFetchRestore("dbt test results", () => {
  test("indexes a failing test with its tested model, and nothing about the row data", async () => {
    const db = createMemoryIndexDb();
    const calls: string[] = [];
    globalThis.fetch = route((u) => {
      if (u.includes("/runs/90/artifacts/run_results.json")) return json(RESULTS);
      if (u.includes("/runs/90/artifacts/manifest.json")) return json(MANIFEST);
      if (u.includes("/runs/?")) return json({ data: [run(90, 10, 20)] });
      return undefined;
    }, calls);
    const r = await syncable().sync(syncTestContext(db, vault(), "dbt"), null);
    const rows = testRows(db);
    expect(rows).toHaveLength(1);
    const meta = JSON.parse(rows[0]?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["monitoredDataModelKeys"]).toEqual(["analytics.sales.orders"]);
    expect(meta["status"]).toBe("fail");
    expect(meta["failures"]).toBe(3);
    expect(JSON.stringify(rows)).not.toContain(SENTINEL);
    expect(r.itemsUpserted).toBe(1);
    expect(testsCursor(r.cursor)["42"]).toBe(finishedMs(run(90, 10)));
    // the next pass reads no run it has already handled
    calls.length = 0;
    await syncable().sync(syncTestContext(db, vault(), "dbt"), r.cursor);
    expect(calls.some((u) => u.includes("/artifacts/"))).toBe(false);
  });

  test("a run whose tests all pass costs no manifest request", async () => {
    const db = createMemoryIndexDb();
    const calls: string[] = [];
    globalThis.fetch = route((u) => {
      if (u.includes("run_results.json")) {
        return json({ results: [{ unique_id: "test.a.b.c", status: "pass" }] });
      }
      if (u.includes("/runs/?")) return json({ data: [run(1, 5)] });
      return undefined;
    }, calls);
    await syncable().sync(syncTestContext(db, vault(), "dbt"), null);
    expect(testRows(db)).toHaveLength(0);
    expect(calls.some((u) => u.includes("manifest.json"))).toBe(false);
  });

  test("a missing manifest still indexes the test, with no model", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = route((u) => {
      if (u.includes("run_results.json")) return json(RESULTS);
      if (u.includes("manifest.json")) return json({}, 404);
      if (u.includes("/runs/?")) return json({ data: [run(2, 5)] });
      return undefined;
    });
    await syncable().sync(syncTestContext(db, vault(), "dbt"), null);
    const meta = JSON.parse(testRows(db)[0]?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["monitoredDataModelKeys"]).toEqual([]);
  });

  test("unfinished, cancelled and older-than-window runs are not read", async () => {
    const db = createMemoryIndexDb();
    const calls: string[] = [];
    globalThis.fetch = route((u) => {
      if (u.includes("/runs/?")) {
        return json({
          data: [{ id: 1, status: 3, finished_at: null }, run(2, 5, 30), run(3, 60 * 24 * 30)],
        });
      }
      return undefined;
    }, calls);
    await syncable().sync(syncTestContext(db, vault(), "dbt"), null);
    expect(calls.some((u) => u.includes("/artifacts/"))).toBe(false);
  });

  test("an artifact server error stops the pass at that run and keeps the position", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = route((u) => {
      if (u.includes("/runs/11/artifacts/run_results.json")) return json({}, 503);
      if (u.includes("/runs/10/artifacts/run_results.json")) return json({ results: [] });
      if (u.includes("/runs/?")) return json({ data: [run(11, 5), run(10, 20)] });
      return undefined;
    });
    const r = await syncable().sync(syncTestContext(db, vault(), "dbt"), null);
    expect(testsCursor(r.cursor)["42"]).toBe(finishedMs(run(10, 20)));
  });

  test("a 403 on the artifacts is not retried forever; a thrown error never fails the jobs sync", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = route((u) => {
      if (u.includes("/artifacts/")) return json({}, 403);
      if (u.includes("/runs/?")) return json({ data: [run(5, 5)] });
      return undefined;
    });
    const r = await syncable().sync(syncTestContext(db, vault(), "dbt"), null);
    expect(testsCursor(r.cursor)["42"]).toBe(finishedMs(run(5, 5)));

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("/runs/")) throw new Error("boom");
      return json({ data: [{ id: 8, name: "J", state: 1, project_id: 5 }] });
    }) as typeof fetch;
    const failed = await syncable().sync(
      syncTestContext(createMemoryIndexDb(), vault(), "dbt"),
      null,
    );
    expect(failed.itemsUpserted).toBe(1);
  });

  test("an artifact announcing more than the cap is refused, not read", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = route((u) => {
      if (u.includes("run_results.json")) {
        return new Response(JSON.stringify(RESULTS), {
          status: 200,
          headers: { "content-length": String(64 * 1024 * 1024) },
        });
      }
      if (u.includes("/runs/?")) return json({ data: [run(6, 5)] });
      return undefined;
    });
    await syncable().sync(syncTestContext(db, vault(), "dbt"), null);
    expect(testRows(db)).toHaveLength(0);
  });

  test("a transient manifest failure retries the run and stores nothing without model keys", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = route((u) => {
      if (u.includes("run_results.json")) return json(RESULTS);
      if (u.includes("manifest.json")) return json({}, 503);
      if (u.includes("/runs/?")) return json({ data: [run(21, 5)] });
      return undefined;
    });
    const r = await syncable().sync(syncTestContext(db, vault(), "dbt"), null);
    expect(testRows(db)).toHaveLength(0);
    expect(testsCursor(r.cursor)["42"]).toBeLessThan(finishedMs(run(21, 5)));
  });

  test("runs that finished in the same millisecond are all handled across passes", async () => {
    const db = createMemoryIndexDb();
    const same = new Date(NOW - 60_000).toISOString();
    const total = MAX_RUNS_PER_PASS + 1;
    const runs = Array.from({ length: total }, (_, i) => ({
      ...run(200 + i, 1),
      finished_at: same,
    }));
    const seen: number[] = [];
    globalThis.fetch = route((u) => {
      const m = /\/runs\/(\d+)\/artifacts\/run_results\.json/.exec(u);
      if (m !== null) {
        seen.push(Number(m[1]));
        return json({ results: [] });
      }
      if (u.includes("/runs/?")) return json({ data: runs });
      return undefined;
    });
    const fast = (): SyncContext => ({
      ...syncTestContext(db, vault(), "dbt"),
      rateLimiter: { acquire: async () => {} } as unknown as SyncContext["rateLimiter"],
    });
    const r = await syncable().sync(fast(), null);
    expect(seen).toHaveLength(MAX_RUNS_PER_PASS);
    seen.length = 0;
    await syncable().sync(fast(), r.cursor);
    expect(seen).toEqual([200 + total - 1]);
  });

  test("a pass handles the oldest runs first, at most the per-pass cap, and resumes after the last", async () => {
    const db = createMemoryIndexDb();
    const total = MAX_RUNS_PER_PASS + 5;
    const runs = Array.from({ length: total }, (_, i) => run(100 + i, (i + 1) * 2));
    const seen: number[] = [];
    globalThis.fetch = route((u) => {
      const m = /\/runs\/(\d+)\/artifacts\/run_results\.json/.exec(u);
      if (m !== null) {
        seen.push(Number(m[1]));
        return json({ results: [] });
      }
      if (u.includes("/runs/?")) return json({ data: runs });
      return undefined;
    });
    const fast = (): SyncContext => ({
      ...syncTestContext(db, vault(), "dbt"),
      rateLimiter: { acquire: async () => {} } as unknown as SyncContext["rateLimiter"],
    });
    const r = await syncable().sync(fast(), null);
    expect(seen).toHaveLength(MAX_RUNS_PER_PASS);
    // the highest ids here are the oldest runs
    expect(seen[0]).toBe(100 + total - 1);
    seen.length = 0;
    await syncable().sync(fast(), r.cursor);
    expect(seen).toHaveLength(total - MAX_RUNS_PER_PASS);
  });
});

test("a cursor from before the test pass reads as a first pass", () => {
  expect(testsCursor("nimbus-dbt1:e30")).toEqual({});
});
