import { describe, expect, test } from "bun:test";
import {
  type CostPoint,
  DAY_MS,
  OTHER_VALUE,
  seriesHashOf,
  seriesKeyOf,
} from "./cost-item-contract.ts";
import { rollUpCostPoints, rollUpCostPointsDetailed } from "./cost-rollup.ts";

const DAY0 = Date.UTC(2026, 9, 1);
const SYNCED = Date.UTC(2026, 10, 12);

function point(
  name: string,
  dayIndex: number,
  amount: number,
  extra: Partial<CostPoint> = {},
): CostPoint {
  return {
    scopeId: "default",
    dimensionKind: "service",
    dimensionKey: null,
    dimensionValue: name,
    groupings: ["service"],
    seriesKey: seriesKeyOf("vantage", "default", "service", null, name),
    seriesHash: seriesHashOf("service", null, name),
    dayMs: DAY0 + dayIndex * DAY_MS,
    amount,
    currency: "USD",
    provider: "aws",
    cloudService: name,
    ...extra,
  };
}

const OTHER_HASH = seriesHashOf("other", null, OTHER_VALUE);
const opts = (maxSeries: number, existing: string[] = []) => ({
  service: "vantage" as const,
  scopeId: "default",
  maxSeries,
  existingSeriesHashes: new Set(existing),
  syncedAt: SYNCED,
});

function names(rows: ReturnType<typeof rollUpCostPoints>): string[] {
  return [...new Set(rows.map((r) => r.metadata.dimensionValue))].sort();
}

describe("rollUpCostPoints", () => {
  test("the first sync names the top N series by window total and folds the rest", () => {
    const points = [
      point("A", 0, 10),
      point("A", 1, 10),
      point("B", 0, 50),
      point("C", 0, 5),
      point("D", 0, 1),
    ];
    const rows = rollUpCostPoints(points, opts(2));
    expect(names(rows)).toEqual(["A", "B", OTHER_VALUE]);
    const other = rows.filter((r) => r.metadata.dimensionValue === OTHER_VALUE);
    expect(other).toHaveLength(1);
    expect(other[0]?.metadata.amount).toBe(6);
    expect(other[0]?.metadata.rowCount).toBe(2);
    expect(other[0]?.metadata.seriesHash).toBe(OTHER_HASH);
    expect(other[0]?.metadata.dimensionKind).toBe("other");
  });

  test("ties are broken by seriesKey, deterministically", () => {
    const points = [point("Z", 0, 5), point("M", 0, 5), point("A", 0, 5)];
    expect(names(rollUpCostPoints(points, opts(2)))).toEqual(["A", "M", OTHER_VALUE]);
    expect(names(rollUpCostPoints([...points].reverse(), opts(2)))).toEqual([
      "A",
      "M",
      OTHER_VALUE,
    ]);
  });

  test("a later sync keeps an already-named series named even when it is small today", () => {
    const tiny = point("tiny", 0, 0.01);
    const big = point("big", 0, 900);
    const rows = rollUpCostPoints([tiny, big], opts(1, [tiny.seriesHash]));
    expect(names(rows)).toEqual([OTHER_VALUE, "tiny"]);
  });

  test("a new series joins only while the named set is under the cap", () => {
    const a = point("A", 0, 1);
    const b = point("B", 0, 2);
    const c = point("C", 0, 3);
    const full = rollUpCostPoints([a, b, c], opts(2, [a.seriesHash, b.seriesHash]));
    expect(names(full)).toEqual(["A", "B", OTHER_VALUE]);
    const room = rollUpCostPoints([a, b, c], opts(3, [a.seriesHash, b.seriesHash]));
    expect(names(room)).toEqual(["A", "B", "C"]);
  });

  test("the other series hash in the existing set does not use up a named slot", () => {
    const a = point("A", 0, 1);
    const b = point("B", 0, 2);
    const rows = rollUpCostPoints([a, b], opts(2, [a.seriesHash, OTHER_HASH]));
    expect(names(rows)).toEqual(["A", "B"]);
  });

  test("folded rows of one day sum into one other row per day", () => {
    const points = [
      point("A", 0, 100),
      point("B", 0, 1),
      point("C", 0, 2),
      point("B", 1, 3),
      point("C", 1, 4),
    ];
    const rows = rollUpCostPoints(points, opts(1));
    const other = rows
      .filter((r) => r.metadata.dimensionValue === OTHER_VALUE)
      .sort((x, y) => x.dayMs - y.dayMs);
    expect(other.map((r) => r.metadata.amount)).toEqual([3, 7]);
    expect(other.map((r) => r.metadata.rowCount)).toEqual([2, 2]);
  });

  test("maxSeries 1 and 500 behave", () => {
    const many = Array.from({ length: 600 }, (_, i) =>
      point(`s${String(i).padStart(3, "0")}`, 0, i + 1),
    );
    const one = rollUpCostPoints(many, opts(1));
    expect(one).toHaveLength(2);
    const five = rollUpCostPoints(many, opts(500));
    expect(names(five)).toHaveLength(501);
    const otherRow = five.find((r) => r.metadata.dimensionValue === OTHER_VALUE);
    expect(otherRow?.metadata.rowCount).toBe(100);
  });

  test("amounts sum with no float drift", () => {
    const rows = rollUpCostPoints([point("A", 0, 0.1), point("A", 0, 0.2)], opts(5));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata.amount).toBe(0.3);
    expect(rows[0]?.metadata.rowCount).toBe(2);
  });

  test("a day inside the restate window is provisional and an old one is final", () => {
    const old = point("A", 0, 1);
    const fresh = point("A", 0, 1, { dayMs: startOf(SYNCED) - DAY_MS });
    const rows = rollUpCostPoints([old, fresh], opts(5));
    const byDay = new Map(rows.map((r) => [r.dayMs, r.metadata.finalized]));
    expect(byDay.get(old.dayMs)).toBe(true);
    expect(byDay.get(fresh.dayMs)).toBe(false);
  });

  test("ids and period bounds follow the contract", () => {
    const rows = rollUpCostPoints([point("A", 0, 1)], opts(5));
    const row = rows[0];
    expect(row?.externalId).toBe(`default:${seriesHashOf("service", null, "A")}:2026-10-01`);
    expect(row?.metadata.periodStartMs).toBe(DAY0);
    expect(row?.metadata.periodEndMs).toBe(DAY0 + DAY_MS);
    expect(row?.metadata.granularity).toBe("day");
  });

  test("a folded set with mixed providers carries null for them and keeps the one currency", () => {
    const rows = rollUpCostPoints(
      [
        point("A", 0, 100),
        point("B", 0, 1, { provider: "aws", cloudService: "x" }),
        point("C", 0, 1, { provider: "gcp", cloudService: "y" }),
      ],
      opts(1),
    );
    const other = rows.find((r) => r.metadata.dimensionValue === OTHER_VALUE);
    expect(other?.metadata.currency).toBe("USD");
    expect(other?.metadata.provider).toBeNull();
    expect(other?.metadata.cloudService).toBeNull();
  });

  test("a series-day in two currencies is not summed: no row, and it is counted", () => {
    const out = rollUpCostPointsDetailed(
      [point("A", 0, 1), point("A", 0, 2, { currency: "EUR" }), point("A", 1, 4)],
      opts(5),
    );
    expect(out.mixedCurrencyBuckets).toBe(1);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]?.metadata.amount).toBe(4);
  });

  test("an empty input yields no rows", () => {
    expect(rollUpCostPoints([], opts(5))).toEqual([]);
  });
});

function startOf(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}
