import { describe, expect, test } from "bun:test";
import { ANOMALY_BASELINE_DAYS, ANOMALY_MIN_BASELINE_DAYS, judgeDay } from "./cost-anomaly.ts";
import { DAY_MS } from "./cost-item-contract.ts";
import type { CostSeriesPoint } from "./cost-series.ts";

const D0 = Date.UTC(2026, 10, 1);
const T = { ratio: 1.5, minAmount: 10 };

/** Points for day 0..n-1; `null` leaves a gap, `provisional` lists the days that are not final. */
function series(
  amounts: readonly (number | null)[],
  provisional: readonly number[] = [],
): CostSeriesPoint[] {
  const out: CostSeriesPoint[] = [];
  amounts.forEach((a, i) => {
    if (a !== null) {
      out.push({ dayMs: D0 + i * DAY_MS, amount: a, finalized: !provisional.includes(i) });
    }
  });
  return out;
}
const day = (i: number): number => D0 + i * DAY_MS;

describe("judgeDay", () => {
  test("a steady series is normal with ratio 1", () => {
    const v = judgeDay(series([100, 100, 100, 100, 100, 100, 100, 100]), day(7), T);
    expect(v).toMatchObject({
      kind: "normal",
      baselineDays: 7,
      baselineMean: 100,
      ratio: 1,
      excess: 0,
    });
  });

  test("a spike over the ratio and the floor is an anomaly", () => {
    const v = judgeDay(series([10, 10, 10, 10, 10, 10, 10, 100]), day(7), T);
    expect(v).toMatchObject({
      kind: "anomaly",
      amount: 100,
      baselineMean: 10,
      ratio: 10,
      excess: 90,
    });
  });

  test("the ratio is inclusive: exactly 1.5x flags, just under does not", () => {
    expect(judgeDay(series([100, 100, 100, 100, 100, 100, 100, 150]), day(7), T).kind).toBe(
      "anomaly",
    );
    expect(judgeDay(series([100, 100, 100, 100, 100, 100, 100, 149.9]), day(7), T).kind).toBe(
      "normal",
    );
  });

  test("a spike below the absolute floor is normal, and the floor is configurable", () => {
    const pts = series([0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.9]);
    expect(judgeDay(pts, day(7), T).kind).toBe("normal");
    expect(judgeDay(pts, day(7), { ratio: 1.5, minAmount: 0.5 }).kind).toBe("anomaly");
  });

  test("the floor applies to the excess over the baseline, not to the amount", () => {
    expect(judgeDay(series([5, 5, 5, 5, 5, 5, 5, 20]), day(7), T).kind).toBe("anomaly");
    expect(judgeDay(series([5, 5, 5, 5, 5, 5, 5, 14]), day(7), T).kind).toBe("normal");
  });

  test("a zero baseline has no ratio: only the floor decides", () => {
    const flat = [0, 0, 0, 0, 0, 0, 0];
    expect(judgeDay(series([...flat, 50]), day(7), T)).toMatchObject({
      kind: "anomaly",
      ratio: null,
      baselineMean: 0,
    });
    expect(judgeDay(series([...flat, 5]), day(7), T).kind).toBe("normal");
    expect(judgeDay(series([...flat, 0]), day(7), { ratio: 1.5, minAmount: 0 }).kind).toBe(
      "normal",
    );
  });

  test("a negative baseline (credits) has no ratio either", () => {
    const v = judgeDay(series([-20, -20, -20, -20, -20, -20, -20, 5]), day(7), T);
    expect(v).toMatchObject({ kind: "anomaly", ratio: null });
  });

  test("a gap in the baseline is not a zero: the mean is over the days that exist", () => {
    const v = judgeDay(series([100, null, 100, 100, null, 100, 100, 100]), day(7), T);
    expect(v).toMatchObject({ kind: "normal", baselineDays: 5, baselineMean: 100 });
  });

  test("fewer than five baseline days is insufficient history, never normal", () => {
    const v = judgeDay(series([100, null, null, 100, null, 100, 100, 10_000]), day(7), T);
    expect(v).toEqual({ kind: "insufficient_history", dayMs: day(7), baselineDays: 4 });
    expect(ANOMALY_MIN_BASELINE_DAYS).toBe(5);
    expect(ANOMALY_BASELINE_DAYS).toBe(7);
  });

  test("too little history overall is insufficient", () => {
    expect(judgeDay(series([10, 10, 10, 500]), day(3), T).kind).toBe("insufficient_history");
  });

  test("days older than the 7-day window do not count toward the baseline", () => {
    const pts = series([1, 1, 1, 1, 1, null, null, null, null, null, null, null, 9]);
    expect(judgeDay(pts, day(12), T).kind).toBe("insufficient_history");
  });

  test("a judged day with no point, or only a provisional one, is no_day", () => {
    expect(judgeDay(series([10, 10, 10, 10, 10, 10, 10, null]), day(7), T)).toEqual({
      kind: "no_day",
      dayMs: day(7),
    });
    expect(judgeDay(series([10, 10, 10, 10, 10, 10, 10, 900], [7]), day(7), T).kind).toBe("no_day");
  });

  test("provisional days never enter the baseline", () => {
    const pts = series([10, 10, 10, 10, 10_000, 10_000, 10_000, 100], [4, 5, 6]);
    expect(judgeDay(pts, day(7), T)).toEqual({
      kind: "insufficient_history",
      dayMs: day(7),
      baselineDays: 4,
    });
    const ok = series([10, 10, 10, 10, 10, 10, 10_000, 100], [6]);
    expect(judgeDay(ok, day(7), T)).toMatchObject({
      kind: "anomaly",
      baselineDays: 6,
      baselineMean: 10,
    });
  });
});
