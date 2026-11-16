// Rows are written by the REAL mapper, rollup and upsert, never hand-built (spec section 5.1).
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { costAllocationItem, mapVantageCostRow } from "../connectors/vantage-cost-mapping.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { COST_ANOMALY_MAX_LISTED, queryCostAnomalies } from "./cost-anomaly-query.ts";
import { type CostPoint, DAY_MS } from "./cost-item-contract.ts";
import { rollUpCostPoints } from "./cost-rollup.ts";

// SYNCED is Nov 12 06:00, so days 0..7 (Nov 1..8) are final and days 8..10 are provisional.
const SYNCED = Date.UTC(2026, 10, 12, 6);
const DAY0 = Date.UTC(2026, 10, 1);
const CTX = { scopeId: "default", groupBy: ["service"] as readonly string[] };
const T = { ratio: 1.5, minAmount: 10 };
const dbs: Database[] = [];

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  dbs.push(db);
  return db;
}
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

interface Spec {
  readonly service: string;
  readonly amounts: readonly (number | null)[];
  readonly currency?: string;
}

function index(db: Database, specs: readonly Spec[], syncedAt = SYNCED): void {
  const rows: unknown[] = [];
  for (const s of specs) {
    s.amounts.forEach((a, d) => {
      if (a === null) return;
      rows.push({
        accrued_at: new Date(DAY0 + d * DAY_MS).toISOString().slice(0, 10),
        amount: String(a),
        currency: s.currency ?? "USD",
        service: s.service,
      });
    });
  }
  const points = rows
    .map((r) => mapVantageCostRow(r, CTX))
    .filter((p): p is CostPoint => p !== null);
  const rolled = rollUpCostPoints(points, {
    service: "vantage",
    scopeId: "default",
    maxSeries: 500,
    existingSeriesHashes: new Set(),
    syncedAt,
  });
  for (const r of rolled) upsertIndexedItem(db, costAllocationItem(r, syncedAt));
}

const q = (db: Database, over: Partial<Parameters<typeof queryCostAnomalies>[1]> = {}) =>
  queryCostAnomalies(db, { nowMs: SYNCED, days: 1, thresholds: T, ...over });

const steady = (n: number, v = 100): number[] => Array.from({ length: n }, () => v);

describe("queryCostAnomalies", () => {
  test("an empty index is no_data", () => {
    const r = q(freshDb());
    expect(r.status).toBe("no_data");
    expect(r.judgedDayMs).toBeNull();
    expect(r.gaps[0]).toContain("No cost data");
  });

  test("only provisional rows is no_data with its own message", () => {
    const db = freshDb();
    index(db, [{ service: "EC2", amounts: [100, 100] }], DAY0 + DAY_MS);
    const r = q(db);
    expect(r.status).toBe("no_data");
    expect(r.gaps[0]).toContain("provisional");
  });

  test("steady spend is ok, names the judged day and counts the series", () => {
    const db = freshDb();
    index(db, [{ service: "EC2", amounts: steady(11) }]);
    const r = q(db);
    expect(r.status).toBe("ok");
    expect(r.judgedDayMs).toBe(DAY0 + 7 * DAY_MS);
    expect(r.counts).toMatchObject({ series: 1, judged: 1, anomalies: 0, insufficientHistory: 0 });
    expect(r.baseline).toEqual({ days: 7, minDays: 5 });
    expect(r.thresholds).toEqual(T);
  });

  test("a spike on the newest complete day is an anomaly; provisional spikes are ignored", () => {
    const db = freshDb();
    index(db, [
      { service: "EC2", amounts: [...steady(7, 10), 100, 9999, 9999, 9999] },
      { service: "S3", amounts: steady(11, 50) },
    ]);
    const r = q(db);
    expect(r.status).toBe("anomalies");
    expect(r.counts).toMatchObject({ series: 2, judged: 2, anomalies: 1 });
    expect(r.anomalies).toHaveLength(1);
    expect(r.anomalies[0]).toMatchObject({
      name: "EC2",
      dayMs: DAY0 + 7 * DAY_MS,
      amount: 100,
      baselineMean: 10,
      ratio: 10,
      excess: 90,
      currency: "USD",
    });
  });

  test("a spike below the floor is not flagged", () => {
    const db = freshDb();
    index(db, [{ service: "Tiny", amounts: [...steady(7, 0.1), 0.9, 0.1, 0.1, 0.1] }]);
    expect(q(db).status).toBe("ok");
  });

  test("a new series with too little history is skipped and counted, not called normal", () => {
    const db = freshDb();
    index(db, [
      { service: "Old", amounts: steady(11) },
      { service: "New", amounts: [null, null, null, null, null, null, 5, 500, 5, 5, 5] },
    ]);
    const r = q(db);
    expect(r.status).toBe("ok");
    expect(r.counts).toMatchObject({ series: 2, judged: 1, insufficientHistory: 1 });
    expect(r.gaps.join(" ")).toContain("fewer than 5 complete days");
  });

  test("when nothing can be judged the status is insufficient_history, not ok", () => {
    const db = freshDb();
    index(db, [{ service: "New", amounts: [null, null, null, null, null, 5, 5, 500, 5, 5, 5] }]);
    const r = q(db);
    expect(r.status).toBe("insufficient_history");
    expect(r.judgedDayMs).toBe(DAY0 + 7 * DAY_MS);
    expect(r.counts.judged).toBe(0);
  });

  test("a gap in the baseline leaves the mean over the days that exist", () => {
    const db = freshDb();
    index(db, [{ service: "EC2", amounts: [10, null, 10, null, 10, 10, 10, 100, 1, 1, 1] }]);
    const r = q(db);
    expect(r.status).toBe("anomalies");
    expect(r.anomalies[0]).toMatchObject({ baselineDays: 5, baselineMean: 10 });
  });

  test("a series with no row on the judged day is counted as noDayData", () => {
    const db = freshDb();
    index(db, [
      { service: "A", amounts: steady(11) },
      { service: "Gone", amounts: [...steady(7), null, 1, 1, 1] },
    ]);
    const r = q(db);
    expect(r.counts).toMatchObject({ judged: 1, noDayData: 1 });
    expect(r.gaps.join(" ")).toContain("no complete row");
  });

  test("a series that reports in two currencies is skipped and counted", () => {
    const db = freshDb();
    index(db, [
      { service: "Mixed", amounts: [100, 100, 100, 100, null, null, null, null], currency: "USD" },
      { service: "Mixed", amounts: [null, null, null, null, 100, 100, 100, 100], currency: "EUR" },
      { service: "Fine", amounts: steady(11) },
    ]);
    const r = q(db);
    expect(r.counts).toMatchObject({ series: 2, mixedCurrency: 1, judged: 1 });
    expect(r.gaps.join(" ")).toContain("more than one currency");
  });

  test("days > 1 judges each recent day against its own baseline", () => {
    const db = freshDb();
    index(db, [{ service: "EC2", amounts: [10, 10, 10, 10, 10, 10, 100, 10, 1, 1, 1] }]);
    const one = q(db, { days: 1 });
    expect(one.status).toBe("ok");
    const two = q(db, { days: 2 });
    expect(two.daysChecked).toBe(2);
    expect(two.counts).toMatchObject({ judged: 2, anomalies: 1 });
    expect(two.anomalies[0]).toMatchObject({
      dayMs: DAY0 + 6 * DAY_MS,
      baselineDays: 6,
      excess: 90,
    });
  });

  test("the list is sorted by excess and capped, with the rest counted", () => {
    const db = freshDb();
    const specs: Spec[] = [];
    for (let i = 0; i < COST_ANOMALY_MAX_LISTED + 5; i += 1) {
      specs.push({
        service: `svc${String(i).padStart(3, "0")}`,
        amounts: [...steady(7, 10), 20 + i, 1, 1, 1],
      });
    }
    index(db, specs);
    const r = q(db);
    expect(r.counts.anomalies).toBe(COST_ANOMALY_MAX_LISTED + 5);
    expect(r.anomalies).toHaveLength(COST_ANOMALY_MAX_LISTED);
    expect(r.anomaliesTruncated).toBe(5);
    expect(r.anomalies[0]?.excess).toBeGreaterThan(r.anomalies[1]?.excess ?? 0);
  });

  test("the service filter restricts the read, and days is clamped", () => {
    const db = freshDb();
    index(db, [{ service: "EC2", amounts: steady(11) }]);
    expect(q(db, { service: "vantage" }).counts.series).toBe(1);
    expect(q(db, { service: "kubecost" }).status).toBe("no_data");
    expect(q(db, { service: "nonsense" }).status).toBe("no_data");
    expect(q(db, { days: 500 }).daysChecked).toBe(30);
    expect(q(db, { days: 0 }).daysChecked).toBe(1);
  });
});
