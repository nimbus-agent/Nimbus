// Phase 10 FinOps: the pure cost anomaly rule (the detector half of the "cost anomaly detection" row).
//
// Confined by static rule D48: no network, no connector, no model. This file judges ONE series on ONE
// UTC day from points the reader (`cost-series.ts`) returned; it reads nothing itself.
//
// The rule, in full:
//   - Only FINALIZED points count, both as the judged day and in the baseline. A provisional day (the
//     vendor may still restate it) is never judged and never part of an average.
//   - The baseline is the mean of the finalized days among the 7 UTC days BEFORE the judged day. A day
//     with no point is NOT counted as zero: the mean is over the days that exist.
//   - Fewer than 5 of those 7 days present is `insufficient_history`, never "no anomaly".
//   - A judged day with no finalized point is `no_day`: a missing day is not a zero.
//   - The day is an anomaly when `amount >= baselineMean * ratio` AND `amount - baselineMean >= minAmount`.
//     The absolute floor keeps a series that goes from 0.10 to 0.40 a day from flagging; with a zero (or
//     negative, a credit) baseline the ratio is undefined and only the floor decides.
import { DAY_MS } from "./cost-item-contract.ts";
import type { CostSeriesPoint } from "./cost-series.ts";

export const ANOMALY_BASELINE_DAYS = 7;
export const ANOMALY_MIN_BASELINE_DAYS = 5;

export interface AnomalyThresholds {
  readonly ratio: number;
  readonly minAmount: number;
}

export type DayVerdict =
  | {
      readonly kind: "normal" | "anomaly";
      readonly dayMs: number;
      readonly amount: number;
      readonly baselineMean: number;
      readonly baselineDays: number;
      /** `amount / baselineMean`; null when the baseline is not positive. */
      readonly ratio: number | null;
      readonly excess: number;
    }
  | { readonly kind: "insufficient_history"; readonly dayMs: number; readonly baselineDays: number }
  | { readonly kind: "no_day"; readonly dayMs: number };

/** Judge `dayMs` (a UTC day start) of one series. */
export function judgeDay(
  points: readonly CostSeriesPoint[],
  dayMs: number,
  thresholds: AnomalyThresholds,
): DayVerdict {
  const byDay = new Map<number, number>();
  for (const p of points) {
    if (p.finalized) byDay.set(p.dayMs, p.amount);
  }
  const amount = byDay.get(dayMs);
  if (amount === undefined) return { kind: "no_day", dayMs };
  let sum = 0;
  let baselineDays = 0;
  for (let i = 1; i <= ANOMALY_BASELINE_DAYS; i += 1) {
    const v = byDay.get(dayMs - i * DAY_MS);
    if (v !== undefined) {
      sum += v;
      baselineDays += 1;
    }
  }
  if (baselineDays < ANOMALY_MIN_BASELINE_DAYS) {
    return { kind: "insufficient_history", dayMs, baselineDays };
  }
  const baselineMean = sum / baselineDays;
  const excess = amount - baselineMean;
  const overRatio = baselineMean > 0 ? amount >= baselineMean * thresholds.ratio : amount > 0;
  const anomalous = overRatio && excess >= thresholds.minAmount && excess > 0;
  return {
    kind: anomalous ? "anomaly" : "normal",
    dayMs,
    amount,
    baselineMean,
    baselineDays,
    ratio: baselineMean > 0 ? amount / baselineMean : null,
    excess,
  };
}
