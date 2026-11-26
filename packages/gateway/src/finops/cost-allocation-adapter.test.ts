import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { upsertIndexedItem } from "../index/item-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { adaptCostAllocationItems, readClusterAllocations } from "./cost-allocation-adapter.ts";

const DAY = (d: number): number => Date.UTC(2026, 10, d);
let db: Database;
let n = 0;

function seed(o: {
  service?: string;
  day: number;
  amount: number;
  scope?: string;
  kind?: string;
  key?: string | null;
  value?: string;
  provider?: string | null;
  cloud?: string | null;
  currency?: string | null;
  synced?: number;
}): void {
  n++;
  upsertIndexedItem(db, {
    service: o.service ?? "vantage",
    type: "cost_allocation",
    externalId: `r${String(n)}`,
    title: "t",
    bodyPreview: "t",
    modifiedAt: DAY(o.day),
    metadata: {
      scopeSeries: `${o.scope ?? "rep|ws|service"}~h${String(n)}`,
      dimensionKind: o.kind ?? "service",
      dimensionKey: o.key ?? null,
      dimensionValue: o.value ?? "Amazon S3",
      periodStartMs: DAY(o.day),
      periodEndMs: DAY(o.day) + 86_400_000,
      amount: o.amount,
      currency: o.currency === undefined ? "USD" : o.currency,
      provider: o.provider === undefined ? "aws" : o.provider,
      cloudService: o.cloud === undefined ? null : o.cloud,
    },
    syncedAt: o.synced ?? DAY(20),
  });
}

/** A row with exactly this metadata (the edge cases `seed` normalises away). */
function seedRaw(service: string, metadata: Record<string, unknown>, synced = DAY(20)): void {
  n++;
  upsertIndexedItem(db, {
    service,
    type: "cost_allocation",
    externalId: `raw${String(n)}`,
    title: "t",
    bodyPreview: "t",
    modifiedAt: DAY(1),
    metadata,
    syncedAt: synced,
  });
}

beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
});
afterEach(() => {
  db.close();
});

describe("adaptCostAllocationItems", () => {
  test("Vantage rows become cost lines with provider, service, currency and a tag dimension", () => {
    seed({ day: 1, amount: 5 });
    seed({
      day: 1,
      amount: 2,
      kind: "tag",
      key: "product",
      value: "checkout",
      cloud: "Amazon EC2",
    });
    seed({ day: 2, amount: 3, provider: null, currency: null });
    const r = adaptCostAllocationItems(db, { fromDay: "2026-11-01", toDay: "2026-11-02" });
    expect(r.supersededDays).toBe(0);
    expect(r.lastDay).toBe("2026-11-02");
    expect(
      r.lines.map((l) => [
        l.chargeDay,
        l.provider,
        l.serviceName,
        l.currency,
        l.billedCost,
        l.tags,
      ]),
    ).toEqual([
      ["2026-11-01", "aws", "Amazon S3", "USD", 5, {}],
      ["2026-11-01", "aws", "Amazon EC2", "USD", 2, { product: "checkout" }],
      ["2026-11-02", "unknown", "Amazon S3", "unknown", 3, {}],
    ]);
    expect(r.lines.every((l) => l.source === "vantage")).toBe(true);
  });

  test("two report configurations on one day: only the newest synced one is used, the day is counted", () => {
    seed({ day: 1, amount: 10, scope: "rep|ws|service", synced: DAY(10) });
    seed({ day: 1, amount: 10, scope: "rep|ws|provider", synced: DAY(20) });
    const r = adaptCostAllocationItems(db, { fromDay: "2026-11-01", toDay: "2026-11-01" });
    expect(r.lines).toHaveLength(1);
    expect(r.supersededDays).toBe(1);
  });

  test("Kubecost and OpenCost rows are never adapted into cloud lines", () => {
    seed({ service: "kubecost", day: 1, amount: 7, kind: "namespace", value: "web" });
    expect(
      adaptCostAllocationItems(db, { fromDay: "2026-11-01", toDay: "2026-11-01" }).lines,
    ).toEqual([]);
  });

  test("the range bounds are inclusive UTC days", () => {
    seed({ day: 1, amount: 1 });
    seed({ day: 3, amount: 1 });
    expect(
      adaptCostAllocationItems(db, { fromDay: "2026-11-02", toDay: "2026-11-03" }).lines,
    ).toHaveLength(1);
  });
});

describe("adaptCostAllocationItems: dimension edge cases", () => {
  test("an account dimension names the sub-account; a non-service dimension gets a placeholder service", () => {
    seed({ day: 1, amount: 4, kind: "account", value: "210000000001" });
    seed({ day: 1, amount: 1, kind: "service" });
    const r = adaptCostAllocationItems(db, { fromDay: "2026-11-01", toDay: "2026-11-01" });
    // The read has no ORDER BY, so the row order is the query plan's: compare as a sorted list.
    const got = r.lines.map((l) => [l.subAccountId ?? "", l.serviceName]).sort();
    expect(got).toEqual([
      ["", "Amazon S3"],
      ["210000000001", "(vantage account)"],
    ]);
  });

  test("a row with no dimension kind is the total; a scope without a hash is its own configuration", () => {
    seedRaw("vantage", {
      scopeSeries: "rep|ws|none",
      dimensionKind: null,
      dimensionValue: null,
      periodStartMs: DAY(1),
      amount: 6,
      currency: "EUR",
      provider: "gcp",
    });
    const r = adaptCostAllocationItems(db, { fromDay: "2026-11-01", toDay: "2026-11-01" });
    expect(r.lines.map((l) => [l.billingAccountId, l.serviceName, l.currency, l.tags])).toEqual([
      ["rep|ws|none", "(vantage total)", "EUR", {}],
    ]);
  });

  test("a row with no scope still adapts, under an empty configuration", () => {
    seedRaw("vantage", {
      dimensionKind: "service",
      dimensionValue: "BigQuery",
      periodStartMs: DAY(1),
      amount: 2,
    });
    const r = adaptCostAllocationItems(db, { fromDay: "2026-11-01", toDay: "2026-11-01" });
    expect(r.lines.map((l) => [l.billingAccountId, l.serviceName, l.billedCost])).toEqual([
      ["", "BigQuery", 2],
    ]);
  });

  test("a tag dimension without a key keeps no tag; a non-numeric amount is dropped", () => {
    seed({ day: 1, amount: 3, kind: "tag", key: null, value: "orphan" });
    seedRaw("vantage", {
      scopeSeries: "rep|ws|service~h",
      dimensionKind: "service",
      dimensionValue: "S3",
      periodStartMs: DAY(1),
      amount: "12.5",
    });
    const r = adaptCostAllocationItems(db, { fromDay: "2026-11-01", toDay: "2026-11-01" });
    expect(r.lines.map((l) => [l.billedCost, l.tags])).toEqual([[3, {}]]);
  });

  test("no Vantage rows at all: no lines, no last day and no currency", () => {
    expect(adaptCostAllocationItems(db, { fromDay: "2026-11-01", toDay: "2026-11-30" })).toEqual({
      lines: [],
      supersededDays: 0,
      lastDay: null,
      currencies: [],
    });
  });
});

describe("readClusterAllocations", () => {
  test("sums Kubecost/OpenCost rows per service, dimension and name; Vantage rows are not read", () => {
    seed({ service: "kubecost", day: 1, amount: 7, kind: "namespace", value: "web" });
    seed({ service: "kubecost", day: 2, amount: 3, kind: "namespace", value: "web" });
    seed({ service: "opencost", day: 1, amount: 1, kind: "namespace", value: "ci" });
    seed({ day: 1, amount: 100 });
    expect(readClusterAllocations(db, { fromDay: "2026-11-01", toDay: "2026-11-02" })).toEqual([
      { service: "kubecost", dimension: "namespace", name: "web", currency: "USD", amount: 10 },
      { service: "opencost", dimension: "namespace", name: "ci", currency: "USD", amount: 1 },
    ]);
  });
  test("missing currency, dimension and name are filled; a non-numeric amount is skipped; ties sort by name", () => {
    seedRaw("opencost", { periodStartMs: DAY(1), amount: 2, currency: null, dimensionKind: null });
    seedRaw("opencost", {
      periodStartMs: DAY(1),
      amount: "9",
      dimensionKind: "namespace",
      dimensionValue: "x",
    });
    seed({ service: "kubecost", day: 1, amount: 2, kind: "namespace", value: "b" });
    seed({ service: "kubecost", day: 1, amount: 2, kind: "namespace", value: "a" });
    expect(readClusterAllocations(db, { fromDay: "2026-11-01", toDay: "2026-11-01" })).toEqual([
      { service: "opencost", dimension: "other", name: "", currency: "unknown", amount: 2 },
      { service: "kubecost", dimension: "namespace", name: "a", currency: "USD", amount: 2 },
      { service: "kubecost", dimension: "namespace", name: "b", currency: "USD", amount: 2 },
    ]);
  });
});
