import { describe, expect, test } from "bun:test";
import { rollUpCostPointsDetailed } from "../finops/cost-rollup.ts";
import { k8sCostAllocationItem, mapK8sCostRow } from "./k8s-cost-mapping.ts";

const ctx = { service: "opencost", scopeId: "default", aggregate: "namespace" } as const;

const ROW = { date: "2026-11-20", key: "kube-system", totalCost: 3.25 };

describe("mapK8sCostRow", () => {
  test("maps one namespace-day to a point with no currency", () => {
    const p = mapK8sCostRow(ROW, ctx);
    expect(p).toMatchObject({
      dimensionKind: "namespace",
      dimensionKey: null,
      dimensionValue: "kube-system",
      groupings: ["namespace"],
      dayMs: Date.UTC(2026, 10, 20),
      amount: 3.25,
      currency: null,
      provider: null,
      cloudService: null,
    });
  });

  test("the same key under another aggregate or service is another series", () => {
    const a = mapK8sCostRow(ROW, ctx);
    const b = mapK8sCostRow(ROW, { ...ctx, aggregate: "controller" });
    const c = mapK8sCostRow(ROW, { ...ctx, service: "kubecost" });
    expect(b?.dimensionKind).toBe("controller");
    expect(a?.seriesHash).not.toBe(b?.seriesHash);
    expect(a?.seriesKey).not.toBe(c?.seriesKey);
  });

  test("a long key is bounded and keeps a hash suffix", () => {
    const p = mapK8sCostRow({ ...ROW, key: "n".repeat(500) }, ctx);
    expect(p?.dimensionValue.length).toBeLessThanOrEqual(200);
  });

  test.each([
    ["not an object", 7],
    ["no date", { key: "a", totalCost: 1 }],
    ["date not YYYY-MM-DD", { ...ROW, date: "2026-11-20T00:00:00Z" }],
    ["impossible date", { ...ROW, date: "2026-13-45" }],
    ["empty key", { ...ROW, key: "" }],
    ["string amount", { ...ROW, totalCost: "3" }],
    ["NaN amount", { ...ROW, totalCost: Number.NaN }],
  ])("%s is not a point", (_name, raw) => {
    expect(mapK8sCostRow(raw, ctx)).toBeNull();
  });
});

describe("k8sCostAllocationItem", () => {
  test("is a metadata-only cost_allocation row of its own service", () => {
    const point = mapK8sCostRow(ROW, ctx);
    if (point === null) throw new Error("no point");
    const syncedAt = Date.UTC(2026, 11, 1);
    const { rows } = rollUpCostPointsDetailed([point], {
      service: "opencost",
      scopeId: "default",
      maxSeries: 10,
      existingSeriesHashes: new Set(),
      syncedAt,
    });
    const first = rows[0];
    if (first === undefined) throw new Error("no row");
    const item = k8sCostAllocationItem("opencost", first, syncedAt);
    expect(item).toMatchObject({
      service: "opencost",
      type: "cost_allocation",
      url: null,
      canonicalUrl: null,
      title: "kube-system 2026-11-20 3.25",
    });
    expect(item.metadata).toMatchObject({ amount: 3.25, currency: null, finalized: true });
    expect(item.externalId).toBe(first.externalId);
  });
});
