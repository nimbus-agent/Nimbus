import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import { HOUR, T0 } from "./__fixtures__/index-writers.ts";
import { buildRecord } from "./__fixtures__/record-builder.ts";
import { RECORDS_LIST_CAP, readHandoffRecords, SMOULDERING_AFTER_MS } from "./handoff-records.ts";
import { upsertIncidentRecord } from "./incident-store.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});
function db(): Database {
  const d = createMemoryIndexDb();
  dbs.push(d);
  return d;
}

type Over = {
  readonly id: string;
  readonly openedAtMs?: number | null;
  readonly closedAtMs?: number | null;
  readonly status?: "open" | "closed";
  readonly service?: string | null;
  readonly title?: string;
  readonly checkedAtMs?: number;
};

function put(d: Database, o: Over): void {
  const base = buildRecord({
    itemId: `pagerduty:${o.id}`,
    title: o.title ?? `Incident ${o.id}`,
    status: o.status ?? "open",
    openedAtMs: o.openedAtMs === undefined ? T0 : o.openedAtMs,
    boundService: o.service === undefined ? "payment-service" : o.service,
  });
  const record = {
    ...base,
    trigger: {
      ...base.trigger,
      closed:
        o.closedAtMs === undefined || o.closedAtMs === null
          ? base.trigger.closed
          : { ms: o.closedAtMs, basis: "provider" as const },
    },
  };
  upsertIncidentRecord(d, {
    record,
    markdown: "m",
    recordSha256: `sha-${o.id}`,
    citedServices: ["pagerduty"],
    nowMs: o.checkedAtMs ?? T0 + 10 * HOUR,
  });
}

const WIN = { fromMs: T0 - HOUR, toMs: T0 + 8 * HOUR, nowMs: T0 + 8 * HOUR, serviceIds: null };
const ids = (xs: readonly { recordId: string; triggerItemId: string }[]): string[] =>
  xs.map((x) => x.triggerItemId.replace("pagerduty:", "")).sort();

describe("readHandoffRecords", () => {
  test("an empty table is no_records and says the lists are empty because nothing was assembled", () => {
    const r = readHandoffRecords(db(), WIN);
    expect(r.status).toBe("no_records");
    expect(r.opened.total).toBe(0);
    expect(r.gaps.map((g) => g.code)).toContain("no_records");
    expect(r.freshness.map((f) => f.service)).toEqual([
      "pagerduty",
      "jira",
      "sentry",
      "montecarlo",
      "bigeye",
    ]);
  });

  test("partitions opened, resolved and still open", () => {
    const d = db();
    put(d, { id: "OPEN", openedAtMs: T0 });
    put(d, { id: "RES", openedAtMs: T0 + HOUR, status: "closed", closedAtMs: T0 + 2 * HOUR });
    put(d, {
      id: "OLDRES",
      openedAtMs: T0 - 5 * HOUR,
      status: "closed",
      closedAtMs: T0 - 4 * HOUR,
    });
    put(d, { id: "BEFORE", openedAtMs: T0 - 3 * HOUR });
    const r = readHandoffRecords(d, WIN);
    expect(ids(r.opened.items)).toEqual(["OPEN", "RES"]);
    expect(ids(r.resolved.items)).toEqual(["RES"]);
    expect(ids(r.stillOpen.items)).toEqual(["BEFORE", "OPEN"]);
  });

  test("window edges are inclusive on both sides", () => {
    const d = db();
    put(d, { id: "AT_FROM", openedAtMs: WIN.fromMs });
    put(d, { id: "AT_TO", openedAtMs: WIN.toMs });
    put(d, { id: "AFTER", openedAtMs: WIN.toMs + 1 });
    const r = readHandoffRecords(d, WIN);
    expect(ids(r.opened.items)).toEqual(["AT_FROM", "AT_TO"]);
    expect(ids(r.stillOpen.items)).toEqual(["AT_FROM", "AT_TO"]);
  });

  test("a window ending in the past reads a later close as still open then", () => {
    const d = db();
    put(d, { id: "LATE", openedAtMs: T0, status: "closed", closedAtMs: T0 + 6 * HOUR });
    const past = { ...WIN, toMs: T0 + 3 * HOUR, nowMs: T0 + 20 * HOUR };
    const r = readHandoffRecords(d, past);
    expect(ids(r.stillOpen.items)).toEqual(["LATE"]);
    expect(r.resolved.total).toBe(0);
    expect(r.gaps.map((g) => g.code)).toContain("window_ends_in_past");
  });

  test("smouldering: exactly four hours is not, four hours and a millisecond is", () => {
    const d = db();
    put(d, { id: "EXACT", openedAtMs: WIN.toMs - SMOULDERING_AFTER_MS });
    put(d, { id: "OVER", openedAtMs: WIN.toMs - SMOULDERING_AFTER_MS - 1 });
    const r = readHandoffRecords(d, { ...WIN, fromMs: WIN.toMs - 12 * HOUR });
    expect(ids(r.smouldering.items)).toEqual(["OVER"]);
    expect(r.smouldering.items[0]?.reason).toBe("open_over_4h");
  });

  test("a re-triggered record is smouldering once, with that reason, even when also old", () => {
    const d = db();
    put(d, { id: "RE", openedAtMs: T0 - 10 * HOUR });
    d.run(
      `INSERT INTO item_history (item_id, service, type, key, old_value, new_value, observed_at_ms) VALUES (?,?,?,?,?,?,?)`,
      ["pagerduty:RE", "pagerduty", "incident", "status", "resolved", "triggered", T0],
    );
    d.run(
      `INSERT INTO item_history (item_id, service, type, key, old_value, new_value, observed_at_ms) VALUES (?,?,?,?,?,?,?)`,
      ["pagerduty:OTHER", "pagerduty", "incident", "status", "triggered", "acknowledged", T0],
    );
    const r = readHandoffRecords(d, WIN);
    expect(r.smouldering.items.map((s) => [s.triggerItemId, s.reason])).toEqual([
      ["pagerduty:RE", "retriggered"],
    ]);
  });

  test("the service filter keeps only records of those services", () => {
    const d = db();
    put(d, { id: "A", service: "payment-service" });
    put(d, { id: "B", service: "search" });
    put(d, { id: "C", service: null });
    const r = readHandoffRecords(d, { ...WIN, serviceIds: new Set(["payment-service"]) });
    expect(ids(r.opened.items)).toEqual(["A"]);
  });

  test("a record with no open time is in no list and is counted in a gap", () => {
    const d = db();
    put(d, { id: "NOTIME", openedAtMs: null });
    const r = readHandoffRecords(d, WIN);
    expect(r.opened.total + r.stillOpen.total).toBe(0);
    expect(r.gaps.find((g) => g.code === "no_open_time")?.detail).toContain("1 record");
  });

  test("a closed record with no close time is not resolved and is counted in a gap", () => {
    const d = db();
    put(d, { id: "CNT", status: "closed", closedAtMs: null });
    const r = readHandoffRecords(d, WIN);
    expect(r.resolved.total).toBe(0);
    expect(r.gaps.map((g) => g.code)).toContain("closed_time_unknown");
  });

  test("lists are capped with the true total, and the order is deterministic", () => {
    const d = db();
    for (let i = 0; i < RECORDS_LIST_CAP + 7; i += 1) {
      put(d, { id: `R${String(i).padStart(3, "0")}`, openedAtMs: T0 + i });
    }
    const a = readHandoffRecords(d, WIN);
    expect(a.opened.items).toHaveLength(RECORDS_LIST_CAP);
    expect(a.opened.total).toBe(RECORDS_LIST_CAP + 7);
    expect(JSON.stringify(readHandoffRecords(d, WIN))).toBe(JSON.stringify(a));
  });

  test("a stored row whose JSON does not parse does not raise", () => {
    const d = db();
    put(d, { id: "OK" });
    d.run("UPDATE incident_record SET record_json = ? WHERE trigger_item_id = ?", [
      "{not json",
      "pagerduty:OK",
    ]);
    const r = readHandoffRecords(d, WIN);
    expect(ids(r.opened.items)).toEqual(["OK"]);
  });

  test("a closed record refreshed before the window began is not read", () => {
    const d = db();
    put(d, {
      id: "STALE",
      openedAtMs: T0 - 30 * HOUR,
      status: "closed",
      closedAtMs: T0 - 29 * HOUR,
      checkedAtMs: T0 - 28 * HOUR,
    });
    const r = readHandoffRecords(d, WIN);
    expect(r.opened.total + r.resolved.total + r.stillOpen.total).toBe(0);
  });

  test("reads 2,000 records well inside the 15 second budget", () => {
    const d = db();
    d.run("BEGIN");
    for (let i = 0; i < 2000; i += 1) put(d, { id: `P${String(i)}`, openedAtMs: T0 + i });
    d.run("COMMIT");
    const t = Date.now();
    const r = readHandoffRecords(d, WIN);
    expect(r.opened.total).toBe(2000);
    expect(Date.now() - t).toBeLessThan(2000);
  });

  test("always says that proposals, runbook steps and findings are not read", () => {
    const r = readHandoffRecords(db(), WIN);
    expect(r.gaps.map((g) => g.code)).toContain("proposals_runbook_findings");
  });
});
