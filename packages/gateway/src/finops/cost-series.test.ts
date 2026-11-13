// Rows are written by the REAL mapper, rollup and upsert, never hand-built: a fixture must come from
// the writer (spec section 5.1).
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { costAllocationItem, mapVantageCostRow } from "../connectors/vantage-cost-mapping.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { type CostPoint, DAY_MS, OTHER_VALUE, seriesKeyOf } from "./cost-item-contract.ts";
import { rollUpCostPoints } from "./cost-rollup.ts";
import { readCostSeries } from "./cost-series.ts";

const SYNCED = Date.UTC(2026, 10, 12, 6);
const DAY0 = Date.UTC(2026, 10, 1);
const CTX = { scopeId: "default", groupBy: ["service"] as readonly string[] };
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

function vendorRows(service: string, days: readonly number[], amount = 10): unknown[] {
  return days.map((d) => ({
    accrued_at: new Date(DAY0 + d * DAY_MS).toISOString().slice(0, 10),
    amount: String(amount),
    currency: "USD",
    service,
  }));
}

function index(db: Database, rows: readonly unknown[], maxSeries = 500): void {
  const points = rows
    .map((r) => mapVantageCostRow(r, CTX))
    .filter((p): p is CostPoint => p !== null);
  const rolled = rollUpCostPoints(points, {
    service: "vantage",
    scopeId: "default",
    maxSeries,
    existingSeriesHashes: new Set(),
    syncedAt: SYNCED,
  });
  for (const r of rolled) {
    upsertIndexedItem(db, costAllocationItem(r, SYNCED));
  }
}

const key = (name: string) => seriesKeyOf("vantage", "default", "service", null, name);

describe("readCostSeries", () => {
  test("returns the daily series with a missing day in gaps", () => {
    const db = freshDb();
    index(db, vendorRows("EC2", [0, 1, 3, 4]));
    const out = readCostSeries(db, {
      seriesKey: key("EC2"),
      fromMs: DAY0,
      toMs: DAY0 + 4 * DAY_MS,
    });
    expect(out.points.map((p) => p.dayMs)).toEqual([0, 1, 3, 4].map((d) => DAY0 + d * DAY_MS));
    expect(out.points.every((p) => p.amount === 10)).toBe(true);
    expect(out.gaps).toEqual([DAY0 + 2 * DAY_MS]);
  });

  test("finalizedOnly drops provisional days", () => {
    const db = freshDb();
    index(db, vendorRows("EC2", [0, 9, 10, 11]));
    const all = readCostSeries(db, {
      seriesKey: key("EC2"),
      fromMs: DAY0,
      toMs: DAY0 + 11 * DAY_MS,
    });
    expect(all.points.filter((p) => !p.finalized).length).toBeGreaterThan(0);
    const fin = readCostSeries(db, {
      seriesKey: key("EC2"),
      fromMs: DAY0,
      toMs: DAY0 + 11 * DAY_MS,
      finalizedOnly: true,
    });
    expect(fin.points.every((p) => p.finalized)).toBe(true);
    expect(fin.points.length).toBeLessThan(all.points.length);
  });

  test("fromMs and toMs bound the days", () => {
    const db = freshDb();
    index(db, vendorRows("EC2", [0, 1, 2, 3, 4]));
    const out = readCostSeries(db, {
      seriesKey: key("EC2"),
      fromMs: DAY0 + DAY_MS,
      toMs: DAY0 + 3 * DAY_MS,
    });
    expect(out.points.map((p) => p.dayMs)).toEqual([1, 2, 3].map((d) => DAY0 + d * DAY_MS));
    expect(out.gaps).toEqual([]);
  });

  test("a different seriesKey is excluded and an __other__ series is readable", () => {
    const db = freshDb();
    index(db, [...vendorRows("big", [0, 1], 100), ...vendorRows("small", [0, 1], 1)], 1);
    const small = readCostSeries(db, {
      seriesKey: key("small"),
      fromMs: DAY0,
      toMs: DAY0 + DAY_MS,
    });
    expect(small.points).toEqual([]);
    const otherKey = seriesKeyOf("vantage", "default", "other", null, OTHER_VALUE);
    const other = readCostSeries(db, { seriesKey: otherKey, fromMs: DAY0, toMs: DAY0 + DAY_MS });
    expect(other.points).toHaveLength(2);
    expect(other.points[0]?.amount).toBe(1);
  });

  test("an empty or inverted range yields nothing; a series key with a service outside the five is refused", () => {
    const db = freshDb();
    index(db, vendorRows("EC2", [0]));
    expect(
      readCostSeries(db, { seriesKey: key("EC2"), fromMs: DAY0 + DAY_MS, toMs: DAY0 }),
    ).toEqual({
      points: [],
      gaps: [],
    });
    expect(
      readCostSeries(db, { seriesKey: "github|default|service||EC2", fromMs: DAY0, toMs: DAY0 }),
    ).toEqual({ points: [], gaps: [] });
  });

  test("writes nothing: row counts and data_version are unchanged", () => {
    const db = freshDb();
    index(db, vendorRows("EC2", [0, 1, 2]));
    const count = () => (db.query("SELECT COUNT(*) AS n FROM item").get() as { n: number }).n;
    const version = () =>
      (db.query("PRAGMA data_version").get() as { data_version: number }).data_version;
    const before = [count(), version()];
    readCostSeries(db, { seriesKey: key("EC2"), fromMs: DAY0, toMs: DAY0 + 2 * DAY_MS });
    expect([count(), version()]).toEqual(before);
  });

  test("the source opens no network and imports no connector, egress or model code", () => {
    const src = readFileSync(new URL("./cost-series.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/\bfetch\b|globalThis|WebSocket|node:http|undici/);
    expect(src).not.toMatch(/from "\.\.\/(connectors|egress|llm|engine|agents)\//);
  });
});
