// Rows are written by the REAL Vantage mappers and upsert, never hand-built.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  costAllocationItem,
  mapVantageCostRow,
  mapVantageRecommendationToItem,
} from "../connectors/vantage-cost-mapping.ts";
import { replaceItemSetRows } from "../index/item-set-store.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { CostPoint } from "./cost-item-contract.ts";
import { rollUpCostPoints } from "./cost-rollup.ts";
import { COST_WASTE_MAX_LISTED, queryCostWaste } from "./cost-waste-query.ts";

const SYNCED = Date.UTC(2026, 10, 18, 6);
const NOW = SYNCED + 3_600_000;
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

interface Rec {
  readonly token: string;
  readonly type?: string;
  readonly description?: string;
  readonly category?: string;
  readonly potential_savings?: string | number;
  readonly currency_code?: string;
  readonly resources_affected_count?: number;
}

function indexRecs(db: Database, recs: readonly Rec[], syncedAt = SYNCED): void {
  for (const r of recs) {
    const item = mapVantageRecommendationToItem({ provider: "aws", ...r }, { syncedAt });
    if (item === null) throw new Error("mapper refused a fixture");
    upsertIndexedItem(db, item);
  }
}

function indexOneCostRow(db: Database): void {
  const p = mapVantageCostRow(
    { accrued_at: "2026-11-10", amount: "5", currency: "USD", service: "EC2" },
    { scopeId: "default", groupBy: ["service"] },
  );
  const points = [p].filter((x): x is CostPoint => x !== null);
  for (const r of rollUpCostPoints(points, {
    service: "vantage",
    scopeId: "default",
    maxSeries: 500,
    existingSeriesHashes: new Set(),
    syncedAt: SYNCED,
  })) {
    upsertIndexedItem(db, costAllocationItem(r, SYNCED));
  }
}

describe("queryCostWaste", () => {
  test("nothing indexed is no_data; cost rows without recommendations is no_waste_found with a gap", () => {
    const db = freshDb();
    expect(queryCostWaste(db, { nowMs: NOW }).status).toBe("no_data");
    indexOneCostRow(db);
    const r = queryCostWaste(db, { nowMs: NOW });
    expect(r.status).toBe("no_waste_found");
    expect(r.gaps.join(" ")).toContain("recommendation drain may have failed");
    expect(r.gaps.join(" ")).toContain("an empty list does not mean there is no waste");
  });

  test("waste is listed, rightsizing is counted but not listed", () => {
    const db = freshDb();
    indexRecs(db, [
      { token: "r1", type: "unattached_ebs_volume", potential_savings: "40", currency_code: "USD" },
      { token: "r2", type: "ec2_rightsizing", potential_savings: "900", currency_code: "USD" },
      { token: "r3", description: "Delete old EBS snapshot", potential_savings: 5 },
    ]);
    const r = queryCostWaste(db, { nowMs: NOW });
    expect(r.status).toBe("waste");
    expect(r.counts).toEqual({ recommendations: 3, waste: 2, notWaste: 1, noEstimate: 0 });
    // r1 (USD) first; r3 has no currency, so it comes last whatever its amount.
    expect(r.candidates.map((c) => c.kind)).toEqual(["unattached", "orphaned_snapshot"]);
    expect(r.candidates[1]?.currency).toBeNull();
    expect(r.candidates[0]?.estimatedMonthlySavings).toBe(40);
    expect(r.lastSyncedMs).toBe(SYNCED);
  });

  test("totals are per currency, and a missing estimate is counted, never zero", () => {
    const db = freshDb();
    indexRecs(db, [
      { token: "a", type: "idle_instance", potential_savings: "10", currency_code: "USD" },
      { token: "b", type: "idle_instance", potential_savings: "20", currency_code: "USD" },
      { token: "c", type: "idle_instance", potential_savings: "7", currency_code: "EUR" },
      { token: "d", type: "idle_instance" },
    ]);
    const r = queryCostWaste(db, { nowMs: NOW });
    expect(r.totals).toEqual([
      { currency: "USD", monthlySavings: 30, count: 2 },
      { currency: "EUR", monthlySavings: 7, count: 1 },
    ]);
    expect(r.byKind).toEqual([
      {
        kind: "idle",
        count: 4,
        noEstimate: 1,
        totals: r.totals,
      },
    ]);
    expect(r.counts.noEstimate).toBe(1);
    // Grouped by currency (EUR before USD, no currency last), largest saving first within one.
    expect(r.candidates.map((c) => c.estimatedMonthlySavings)).toEqual([7, 20, 10, null]);
    expect(r.gaps.join(" ")).toContain("1 candidate(s) have no savings estimate");
  });

  test("only non-waste rows is no_waste_found, not no_data", () => {
    const db = freshDb();
    indexRecs(db, [{ token: "x", type: "savings_plan_purchase", potential_savings: "100" }]);
    const r = queryCostWaste(db, { nowMs: NOW });
    expect(r.status).toBe("no_waste_found");
    expect(r.counts.notWaste).toBe(1);
    expect(r.candidates).toEqual([]);
  });

  test("the kind filter keeps the other kinds out of the list but in the waste count", () => {
    const db = freshDb();
    indexRecs(db, [
      { token: "a", type: "idle_instance", potential_savings: "10" },
      { token: "b", type: "unattached_ip", potential_savings: "3" },
    ]);
    const r = queryCostWaste(db, { nowMs: NOW, kind: "unattached" });
    expect(r.kind).toBe("unattached");
    expect(r.candidates.map((c) => c.kind)).toEqual(["unattached"]);
    expect(r.counts.waste).toBe(2);
    expect(queryCostWaste(db, { nowMs: NOW, kind: "empty_environment" }).status).toBe(
      "no_waste_found",
    );
  });

  test("an unknown service reads nothing", () => {
    const db = freshDb();
    indexRecs(db, [{ token: "a", type: "idle_instance" }]);
    expect(queryCostWaste(db, { nowMs: NOW, service: "nope" }).status).toBe("no_data");
    expect(queryCostWaste(db, { nowMs: NOW, service: "vantage" }).status).toBe("waste");
  });

  test("a stale set gets a gap", () => {
    const db = freshDb();
    indexRecs(db, [{ token: "a", type: "idle_instance" }], SYNCED - 3 * 86_400_000);
    expect(queryCostWaste(db, { nowMs: NOW }).gaps.join(" ")).toContain("more than 24 hours ago");
  });

  test("the list is capped, largest saving first, and the rest counted", () => {
    const db = freshDb();
    const recs: Rec[] = [];
    for (let i = 0; i < COST_WASTE_MAX_LISTED + 5; i += 1) {
      recs.push({ token: `t${String(i)}`, type: "idle_instance", potential_savings: String(i) });
    }
    indexRecs(db, recs);
    const r = queryCostWaste(db, { nowMs: NOW });
    expect(r.candidates).toHaveLength(COST_WASTE_MAX_LISTED);
    expect(r.candidatesTruncated).toBe(5);
    expect(r.candidates[0]?.estimatedMonthlySavings).toBe(COST_WASTE_MAX_LISTED + 4);
  });

  test("a null-currency amount gets its own bucket, never mixed with a named currency", () => {
    const db = freshDb();
    indexRecs(db, [
      { token: "a", type: "idle_instance", potential_savings: "10", currency_code: "USD" },
      { token: "b", type: "idle_instance", potential_savings: "99" },
    ]);
    expect(queryCostWaste(db, { nowMs: NOW }).totals).toEqual([
      { currency: null, monthlySavings: 99, count: 1 },
      { currency: "USD", monthlySavings: 10, count: 1 },
    ]);
  });

  test("only an http(s) documentation link is kept", () => {
    const db = freshDb();
    for (const [token, url] of [
      ["a", "https://docs.example.com/x"],
      ["b", "javascript:alert(1)"],
      ["c", "file:///etc/passwd"],
      ["d", "not a url"],
    ] as const) {
      const item = mapVantageRecommendationToItem(
        { token, type: "idle_instance", documentation_url: url },
        { syncedAt: SYNCED },
      );
      if (item === null) throw new Error("mapper refused a fixture");
      upsertIndexedItem(db, item);
    }
    const urls = queryCostWaste(db, { nowMs: NOW }).candidates.map((c) => c.documentationUrl);
    expect(urls.filter((u) => u !== null)).toEqual(["https://docs.example.com/x"]);
  });

  test("a recommendation the sync's replace dropped is no longer reported", () => {
    const db = freshDb();
    indexRecs(db, [
      { token: "keep", type: "idle_instance", potential_savings: "1" },
      { token: "gone", type: "unattached_volume", potential_savings: "2" },
    ]);
    replaceItemSetRows(db, "vantage", "cost_recommendation", ["keep"]);
    const r = queryCostWaste(db, { nowMs: NOW });
    expect(r.counts.recommendations).toBe(1);
    expect(r.candidates.map((c) => c.kind)).toEqual(["idle"]);
  });
});
