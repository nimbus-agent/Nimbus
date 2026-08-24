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
    const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT, "workday");

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

    const r = await syncable.sync(ctx, null);
    expect(r.itemsUpserted).toBe(3);
    expectServiceItemCount(db, "workday", 3);

    // Verify each type was written
    const rows = db
      .prepare("SELECT external_id, type FROM item WHERE service = 'workday' ORDER BY external_id")
      .all() as Array<{ external_id: string; type: string }>;
    expect(rows).toHaveLength(3);

    const byId = Object.fromEntries(rows.map((row) => [row.external_id, row.type]));
    expect(byId["j1"]).toBe("job_posting");
    expect(byId["t1"]).toBe("time_off");
    expect(byId["w1"]).toBe("worker");
  });

  test("a domain that 404s does not abort the others", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT, "workday");

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
    const r = await syncable.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "workday", 1);
  });

  test("no-ops when loadAccessToken throws", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT, "workday");

    const syncable = createWorkdaySyncable({
      ensureWorkdayMcpRunning: async () => {},
      loadAccessToken: async () => {
        throw new Error("no token");
      },
      loadWorkdayConfig: () => DEFAULT_NIMBUS_WORKDAY_TOML,
      fetchFn: fetchStub({}),
    });

    const r = await syncable.sync(ctx, null);
    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "workday", 0);
  });

  test("returns hasMore=false and a valid cursor on an empty response", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT, "workday");

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

    const r = await syncable.sync(ctx, null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.hasMore).toBe(false);
    expect(r.cursor).toMatch(/^nimbus-workday1:/);
  });

  test("a domain that throws does not abort the others (outer catch)", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT, "workday");

    // /timeOff throws a network error; /workers and /jobRequisitions succeed
    const throwingFetchFn = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/timeOff")) throw new Error("network down");
      if (u.includes("/workers"))
        return new Response(JSON.stringify({ data: [{ id: "w1", name: "Ada" }] }), { status: 200 });
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const syncable = createWorkdaySyncable({
      ensureWorkdayMcpRunning: async () => {},
      loadAccessToken: async () => "tok",
      loadWorkdayConfig: () => DEFAULT_NIMBUS_WORKDAY_TOML,
      fetchFn: throwingFetchFn,
    });

    const r = await syncable.sync(ctx, null);
    // Sync must NOT throw, and the worker from /workers must be upserted
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "workday", 1);
  });

  test("decodeCursor resume: a non-null cursor resumes the workers walk at a non-zero offset", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT, "workday");

    // First pass returns a full page of 50 workers (advancing the worker offset),
    // then an empty page to terminate. Capture every fetched URL, tagged by pass.
    const fiftyWorkers = Array.from({ length: 50 }, (_, i) => ({ id: `w${i}`, name: `W${i}` }));
    let firstWorkersServed = false;
    const urls: string[] = [];
    const captureFetchFn = (async (url: string | URL) => {
      const u = String(url);
      urls.push(u);
      if (u.includes("/workers") && !firstWorkersServed) {
        firstWorkersServed = true;
        return new Response(JSON.stringify({ data: fiftyWorkers }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const syncable = createWorkdaySyncable({
      ensureWorkdayMcpRunning: async () => {},
      loadAccessToken: async () => "tok",
      loadWorkdayConfig: () => DEFAULT_NIMBUS_WORKDAY_TOML,
      fetchFn: captureFetchFn,
    });

    const r1 = await syncable.sync(ctx, null);
    expect(r1.itemsUpserted).toBe(50);
    expect(r1.cursor).toMatch(/^nimbus-workday1:/);

    // Second sync with the non-null cursor exercises the decodeCursor branch and
    // must resume the workers walk at the stored (non-zero) offset.
    urls.length = 0;
    await syncable.sync(ctx, r1.cursor);
    const resumedWorkersUrl = urls.find((u) => u.includes("/workers"));
    expect(resumedWorkersUrl).toBeDefined();
    expect(resumedWorkersUrl).toContain("offset=");
    expect(resumedWorkersUrl).not.toContain("offset=0");
  });

  test("serviceId, defaultIntervalMs, initialSyncDepthDays are correct", () => {
    const syncable = createWorkdaySyncable({
      ensureWorkdayMcpRunning: async () => {},
    });
    expect(syncable.serviceId).toBe("workday");
    expect(syncable.defaultIntervalMs).toBe(10 * 60 * 1000);
    expect(syncable.initialSyncDepthDays).toBe(30);
  });

  test("indexes RaaS report rows from a same-host report url", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT, "workday");

    const syncable = createWorkdaySyncable({
      ensureWorkdayMcpRunning: async () => {},
      loadAccessToken: async () => "tok",
      loadWorkdayConfig: () => ({
        timeOffHistoryDays: 365,
        reports: [
          {
            label: "headcount",
            url: "https://wd5.workday.com/ccx/service/customreport2/acme/ISU/HC?format=json",
          },
        ],
      }),
      // tenantHost injected so sameTenantHost can compare without relying on Config (frozen at import)
      tenantHost: "https://wd5.workday.com",
      fetchFn: fetchStub({
        "/workers": { data: [] },
        "/timeOff": { data: [] },
        "/jobRequisitions": { data: [] },
        "/customreport2/acme/ISU/HC": { Report_Entry: [{ org: "Eng", headcount: 12 }] },
      }),
    });

    const r = await syncable.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "workday", 1);

    const rows = db
      .prepare("SELECT type, metadata FROM item WHERE service = 'workday'")
      .all() as Array<{ type: string; metadata: string }>;
    expect(rows).toHaveLength(1);
    const first = rows[0];
    expect(first).toBeDefined();
    expect(first?.type).toBe("report");
    const meta = JSON.parse(first?.metadata ?? "{}") as { reportLabel?: string };
    expect(meta.reportLabel).toBe("headcount");
  });

  test("rejects a report url whose host != tenant host (no fetch, no upsert)", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT, "workday");

    let evilFetched = false;
    const guardedFetch = (async (url: string | URL) => {
      const u = String(url);
      // Parse the host (not a substring check) so the spy can't be fooled by a host
      // like evil.example.com.attacker.com — and to satisfy CodeQL js/incomplete-url-substring-sanitization.
      if (new URL(u).hostname === "evil.example.com") {
        evilFetched = true;
        return new Response("{}", { status: 200 });
      }
      // REST domains return empty data
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const syncable = createWorkdaySyncable({
      ensureWorkdayMcpRunning: async () => {},
      loadAccessToken: async () => "tok",
      loadWorkdayConfig: () => ({
        timeOffHistoryDays: 365,
        reports: [{ label: "evil", url: "https://evil.example.com/report?format=json" }],
      }),
      tenantHost: "https://wd5.workday.com",
      fetchFn: guardedFetch,
    });

    await syncable.sync(ctx, null);
    expect(evilFetched).toBe(false);
    expectServiceItemCount(db, "workday", 0);
  });

  test("a report fetch that returns non-ok skips that report but continues sync", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT, "workday");

    const syncable = createWorkdaySyncable({
      ensureWorkdayMcpRunning: async () => {},
      loadAccessToken: async () => "tok",
      loadWorkdayConfig: () => ({
        timeOffHistoryDays: 365,
        reports: [
          {
            label: "bad",
            url: "https://wd5.workday.com/ccx/service/customreport2/acme/ISU/BAD?format=json",
          },
        ],
      }),
      tenantHost: "https://wd5.workday.com",
      fetchFn: fetchStub({
        "/workers": { data: [] },
        "/timeOff": { data: [] },
        "/jobRequisitions": { data: [] },
        // /BAD not in map → 404 from fetchStub
      }),
    });

    const r = await syncable.sync(ctx, null);
    // Must not throw; no report item upserted
    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "workday", 0);
  });

  test("falls back to DEFAULT config + globalThis.fetch when neither is injected", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT, "workday");
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch;
    try {
      // No loadWorkdayConfig, no fetchFn → exercise the `?? DEFAULT` and `?? globalThis.fetch` arms.
      const syncable = createWorkdaySyncable({
        ensureWorkdayMcpRunning: async () => {},
        loadAccessToken: async () => "tok",
      });
      const r = await syncable.sync(ctx, null);
      expect(r.itemsUpserted).toBe(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("skips rows that map to null (worker without an id)", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT, "workday");
    const syncable = createWorkdaySyncable({
      ensureWorkdayMcpRunning: async () => {},
      loadAccessToken: async () => "tok",
      loadWorkdayConfig: () => DEFAULT_NIMBUS_WORKDAY_TOML,
      fetchFn: fetchStub({
        "/workers": { data: [{ name: "No Id Here" }] }, // mapWorkerToItem → null (no id)
        "/timeOff": { data: [] },
        "/jobRequisitions": { data: [] },
      }),
    });
    const r = await syncable.sync(ctx, null);
    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "workday", 0);
  });

  test("tolerates malformed domain payloads (bare array + non-array data field)", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT, "workday");
    const malformedFetch = (async (url: string | URL) => {
      const u = String(url);
      // /workers: a BARE array (no {data} wrapper) → exercises the "no data key → parsed" arm.
      if (u.includes("/workers")) {
        return new Response(JSON.stringify([{ id: "w1", name: "Ada" }]), { status: 200 });
      }
      // /timeOff: data is not an array → exercises the "non-array data → []" arm.
      if (u.includes("/timeOff")) {
        return new Response(JSON.stringify({ data: "not-an-array" }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const syncable = createWorkdaySyncable({
      ensureWorkdayMcpRunning: async () => {},
      loadAccessToken: async () => "tok",
      loadWorkdayConfig: () => DEFAULT_NIMBUS_WORKDAY_TOML,
      fetchFn: malformedFetch,
    });
    const r = await syncable.sync(ctx, null);
    // The bare-array worker is still mapped + upserted; the non-array time-off yields nothing.
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "workday", 1);
  });

  test("reportRowsFrom handles a bare-array report and a non-array report body", async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT, "workday");
    const reportFetch = (async (url: string | URL) => {
      const u = String(url);
      // bare array report (no Report_Entry wrapper) → reportRowsFrom returns the array
      if (u.includes("/BARE")) {
        return new Response(JSON.stringify([{ org: "Eng", headcount: 3 }]), { status: 200 });
      }
      // non-array, non-Report_Entry object → reportRowsFrom returns []
      if (u.includes("/EMPTY")) {
        return new Response(JSON.stringify({ unexpected: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const syncable = createWorkdaySyncable({
      ensureWorkdayMcpRunning: async () => {},
      loadAccessToken: async () => "tok",
      loadWorkdayConfig: () => ({
        timeOffHistoryDays: 365,
        reports: [
          { label: "bare", url: "https://wd5.workday.com/ccx/service/customreport2/x/BARE" },
          { label: "empty", url: "https://wd5.workday.com/ccx/service/customreport2/x/EMPTY" },
        ],
      }),
      tenantHost: "https://wd5.workday.com",
      fetchFn: reportFetch,
    });
    const r = await syncable.sync(ctx, null);
    // bare report → 1 row upserted; empty report → 0
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "workday", 1);
  });
});
