import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { createMemoryIndexDb } from "../../connectors/connector-sync-test-helpers.ts";
import { buildRecord } from "../__fixtures__/record-builder.ts";
import { upsertIncidentRecord } from "../incident-store.ts";
import { concurrentLane, skippedConcurrent } from "./concurrent.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

const OPEN = 10_000_000;
const MIN = 60_000;

function put(
  d: Database,
  itemId: string,
  over: { service: string | null; openedAtMs: number; status?: "open" | "closed" },
): void {
  const svc = itemId.slice(0, itemId.indexOf(":")) as "pagerduty";
  upsertIncidentRecord(d, {
    record: buildRecord({
      itemId,
      service: svc,
      openedAtMs: over.openedAtMs,
      boundService: over.service,
      status: over.status ?? "open",
    }),
    markdown: "m",
    recordSha256: itemId,
    citedServices: [svc],
    nowMs: 1,
  });
}

describe("lane 5, concurrent", () => {
  test("only OTHER services, only open, inside +/- 30 minutes, cap 10 with the total", () => {
    const d = createMemoryIndexDb();
    dbs.push(d);
    put(d, "pagerduty:ME", { service: "payments", openedAtMs: OPEN });
    put(d, "jira:SAME", { service: "payments", openedAtMs: OPEN });
    put(d, "jira:IN", { service: "checkout", openedAtMs: OPEN + 30 * MIN });
    put(d, "sentry:EARLY", { service: "auth", openedAtMs: OPEN - 30 * MIN });
    put(d, "sentry:OUT", { service: "auth", openedAtMs: OPEN + 31 * MIN });
    put(d, "sentry:CLOSED", { service: "auth", openedAtMs: OPEN, status: "closed" });
    put(d, "jira:UNBOUND", { service: null, openedAtMs: OPEN + MIN });
    const r = concurrentLane(d, {
      triggerItemId: "pagerduty:ME",
      boundService: "payments",
      openedAtMs: OPEN,
    });
    expect(r.lane.records.map((x) => x.triggerItemId)).toEqual([
      "jira:IN",
      "jira:UNBOUND",
      "sentry:EARLY",
    ]);
    expect(r.lane.total).toBe(3);
    expect(r.lane.records.every((x) => x.rule === "concurrent_30m")).toBe(true);
    expect(r.lane.records[0]).toMatchObject({
      service: "checkout",
      source: "jira",
      severity: "p1",
    });
  });

  test("cap and total; an unbound trigger sees every other open record; ties end in the id", () => {
    const d = createMemoryIndexDb();
    dbs.push(d);
    put(d, "pagerduty:ME", { service: null, openedAtMs: OPEN });
    for (let i = 0; i < 12; i += 1) {
      put(d, `jira:J${String(i).padStart(2, "0")}`, { service: "checkout", openedAtMs: OPEN });
    }
    const r = concurrentLane(d, {
      triggerItemId: "pagerduty:ME",
      boundService: null,
      openedAtMs: OPEN,
    });
    expect(r.lane.total).toBe(12);
    expect(r.lane.records).toHaveLength(10);
    const ids = r.lane.records.map((x) => x.recordId);
    expect([...ids].sort((a, b) => (a < b ? -1 : 1))).toEqual(ids);
  });

  test("skipped without an open time", () => {
    expect(skippedConcurrent().lane).toEqual({ skipped: "no_open_time", total: 0, records: [] });
  });
});
