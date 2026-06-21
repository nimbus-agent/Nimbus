import { describe, expect, test } from "bun:test";
import { DEFAULT_NIMBUS_WORKDAY_TOML } from "../config/nimbus-toml-workday.ts";
import {
  createMemoryIndexDb,
  EMPTY_NIMBUS_VAULT,
  expectServiceItemCount,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import { createWorkdaySyncable } from "./workday-sync.ts";

function fetchStub(map: Record<string, unknown>): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    const key = Object.keys(map).find((k) => u.includes(k));
    if (key === undefined) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(map[key]), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("createWorkdaySyncable", () => {
  test("maps workers + time-off + job-postings into upserts", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT);

    const syncable = createWorkdaySyncable({
      ensureWorkdayMcpRunning: async () => {},
      loadAccessToken: async () => "tok",
      loadWorkdayConfig: () => DEFAULT_NIMBUS_WORKDAY_TOML,
      fetchFn: fetchStub({
        "/workers": {
          data: [{ id: "w1", name: "Ada", title: "Eng" }],
        },
        "/timeOff": {
          data: [
            {
              id: "t1",
              worker: "Ada",
              type: "PTO",
              startDate: "2026-01-01",
              endDate: "2026-01-02",
              status: "Approved",
            },
          ],
        },
        "/jobRequisitions": {
          data: [{ id: "j1", title: "Staff Eng", status: "Open" }],
        },
      }),
    });

    // biome-ignore lint/suspicious/noExplicitAny: minimal fake context
    const r = await syncable.sync(ctx as any, null);
    expect(r.itemsUpserted).toBe(3);
    expectServiceItemCount(db, "workday", 3);

    // Verify each type was written
    const rows = db
      .prepare("SELECT external_id, type FROM item WHERE service = 'workday' ORDER BY external_id")
      .all() as Array<{ external_id: string; type: string }>;
    expect(rows.length).toBe(3);

    const byId = Object.fromEntries(rows.map((row) => [row.external_id, row.type]));
    expect(byId["j1"]).toBe("job_posting");
    expect(byId["t1"]).toBe("time_off");
    expect(byId["w1"]).toBe("worker");
  });

  test("a domain that 404s does not abort the others", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT);

    const syncable = createWorkdaySyncable({
      ensureWorkdayMcpRunning: async () => {},
      loadAccessToken: async () => "tok",
      loadWorkdayConfig: () => DEFAULT_NIMBUS_WORKDAY_TOML,
      // only /workers returns data; /timeOff and /jobRequisitions → 404
      fetchFn: fetchStub({
        "/workers": { data: [{ id: "w1", name: "Ada" }] },
      }),
    });

    // Should NOT throw, worker should still be upserted
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake context
    const r = await syncable.sync(ctx as any, null);
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "workday", 1);
  });

  test("no-ops when loadAccessToken throws", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT);

    const syncable = createWorkdaySyncable({
      ensureWorkdayMcpRunning: async () => {},
      loadAccessToken: async () => {
        throw new Error("no token");
      },
      loadWorkdayConfig: () => DEFAULT_NIMBUS_WORKDAY_TOML,
      fetchFn: fetchStub({}),
    });

    // biome-ignore lint/suspicious/noExplicitAny: minimal fake context
    const r = await syncable.sync(ctx as any, null);
    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "workday", 0);
  });

  test("returns hasMore=false and a valid cursor on an empty response", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT);

    const syncable = createWorkdaySyncable({
      ensureWorkdayMcpRunning: async () => {},
      loadAccessToken: async () => "tok",
      loadWorkdayConfig: () => DEFAULT_NIMBUS_WORKDAY_TOML,
      fetchFn: fetchStub({
        "/workers": { data: [] },
        "/timeOff": { data: [] },
        "/jobRequisitions": { data: [] },
      }),
    });

    // biome-ignore lint/suspicious/noExplicitAny: minimal fake context
    const r = await syncable.sync(ctx as any, null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.hasMore).toBe(false);
    expect(r.cursor).toMatch(/^nimbus-workday1:/);
  });

  test("serviceId, defaultIntervalMs, initialSyncDepthDays are correct", () => {
    const syncable = createWorkdaySyncable({
      ensureWorkdayMcpRunning: async () => {},
    });
    expect(syncable.serviceId).toBe("workday");
    expect(syncable.defaultIntervalMs).toBe(10 * 60 * 1000);
    expect(syncable.initialSyncDepthDays).toBe(30);
  });
});
