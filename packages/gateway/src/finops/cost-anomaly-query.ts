// Phase 10 FinOps: the read surface of the cost anomaly detector (D48: local index only, no network).
//
// One call reads the whole window from the index once, judges every series on each of the last `days`
// complete UTC days and reports what it did NOT judge as plainly as what it found: "no cost data",
// "not enough history" and "nothing anomalous" are three different answers.
import type { Database } from "bun:sqlite";
import {
  ANOMALY_BASELINE_DAYS,
  ANOMALY_MIN_BASELINE_DAYS,
  type AnomalyThresholds,
  judgeDay,
} from "./cost-anomaly.ts";
import { DAY_MS, startOfUtcDay } from "./cost-item-contract.ts";
import { readCostDataExtent, readCostSeriesWindow } from "./cost-series.ts";

export const COST_ANOMALY_MAX_DAYS = 30;
export const COST_ANOMALY_MAX_LISTED = 100;

export interface CostAnomalyQuery {
  readonly nowMs: number;
  readonly service?: string;
  /** How many of the newest complete days to judge (1 to 30), each against its own 7-day baseline. */
  readonly days: number;
  readonly thresholds: AnomalyThresholds;
}

export interface CostAnomaly {
  readonly seriesKey: string;
  /** The series' grouping value, a vendor string. */
  readonly name: string;
  readonly dayMs: number;
  readonly amount: number;
  readonly baselineMean: number;
  readonly baselineDays: number;
  readonly ratio: number | null;
  readonly excess: number;
  readonly currency: string | null;
}

export type CostAnomalyStatus = "no_data" | "insufficient_history" | "ok" | "anomalies";

export interface CostAnomalyResult {
  readonly status: CostAnomalyStatus;
  readonly asOfMs: number;
  readonly service: string | null;
  /** The newest day judged (the newest complete day in the index); null when nothing was judgeable. */
  readonly judgedDayMs: number | null;
  readonly daysChecked: number;
  readonly baseline: { readonly days: number; readonly minDays: number };
  readonly thresholds: AnomalyThresholds;
  readonly counts: {
    readonly series: number;
    /** (series, day) pairs judged as normal or anomalous. */
    readonly judged: number;
    readonly anomalies: number;
    readonly insufficientHistory: number;
    /** (series, day) pairs where the series has no complete row on the judged day. */
    readonly noDayData: number;
    /** A series that reports in more than one currency: not comparable, never judged. */
    readonly mixedCurrency: number;
  };
  /** Largest excess first, at most {@link COST_ANOMALY_MAX_LISTED}. */
  readonly anomalies: readonly CostAnomaly[];
  readonly anomaliesTruncated: number;
  readonly gaps: readonly string[];
}

type Header = Omit<CostAnomalyResult, "status" | "counts" | "gaps">;

function emptyCounts(series: number): CostAnomalyResult["counts"] {
  return {
    series,
    judged: 0,
    anomalies: 0,
    insufficientHistory: 0,
    noDayData: 0,
    mixedCurrency: 0,
  };
}

function header(q: CostAnomalyQuery, days: number): Header {
  return {
    asOfMs: q.nowMs,
    service: q.service ?? null,
    judgedDayMs: null,
    daysChecked: days,
    baseline: { days: ANOMALY_BASELINE_DAYS, minDays: ANOMALY_MIN_BASELINE_DAYS },
    thresholds: q.thresholds,
    anomalies: [],
    anomaliesTruncated: 0,
  };
}

function skipGaps(insufficientHistory: number, noDayData: number, mixedCurrency: number): string[] {
  const gaps: string[] = [];
  if (insufficientHistory > 0) {
    gaps.push(
      `${String(insufficientHistory)} check(s) skipped: fewer than ${String(ANOMALY_MIN_BASELINE_DAYS)} complete days in the ${String(ANOMALY_BASELINE_DAYS)} days before the judged day.`,
    );
  }
  if (noDayData > 0) {
    gaps.push(
      `${String(noDayData)} check(s) skipped: the series has no complete row on the judged day.`,
    );
  }
  if (mixedCurrency > 0) {
    gaps.push(`${String(mixedCurrency)} series skipped: more than one currency in the window.`);
  }
  return gaps;
}

/** Judge every series of the window on each of the newest `days` complete days. */
export function queryCostAnomalies(db: Database, q: CostAnomalyQuery): CostAnomalyResult {
  const days = Math.min(COST_ANOMALY_MAX_DAYS, Math.max(1, Math.floor(q.days)));
  const extent = readCostDataExtent(db, q.service);
  if (extent.rowCount === 0) {
    return {
      ...header(q, days),
      status: "no_data",
      counts: emptyCounts(0),
      gaps: [
        "No cost data is indexed. Configure a FinOps source (for example vantage.api_token) and let it sync.",
      ],
    };
  }
  if (extent.latestFinalizedDayMs === null) {
    return {
      ...header(q, days),
      status: "no_data",
      counts: emptyCounts(0),
      gaps: [
        "Cost rows exist but every day is still provisional (the vendor may restate it); there is no complete day to judge yet.",
      ],
    };
  }
  const newest = startOfUtcDay(extent.latestFinalizedDayMs);
  const seriesSet = readCostSeriesWindow(db, {
    ...(q.service === undefined ? {} : { service: q.service }),
    fromMs: newest - (days - 1 + ANOMALY_BASELINE_DAYS) * DAY_MS,
    toMs: newest,
    finalizedOnly: true,
  });
  let judged = 0;
  let insufficientHistory = 0;
  let noDayData = 0;
  let mixedCurrency = 0;
  const found: CostAnomaly[] = [];
  for (const s of seriesSet) {
    if (s.currencies.length > 1) {
      mixedCurrency += 1;
      continue;
    }
    const currency = s.currencies[0] ?? null;
    for (let i = 0; i < days; i += 1) {
      const v = judgeDay(s.points, newest - i * DAY_MS, q.thresholds);
      if (v.kind === "no_day") {
        noDayData += 1;
      } else if (v.kind === "insufficient_history") {
        insufficientHistory += 1;
      } else {
        judged += 1;
        if (v.kind === "anomaly") {
          found.push({
            seriesKey: s.seriesKey,
            name: s.name,
            dayMs: v.dayMs,
            amount: v.amount,
            baselineMean: v.baselineMean,
            baselineDays: v.baselineDays,
            ratio: v.ratio,
            excess: v.excess,
            currency,
          });
        }
      }
    }
  }
  found.sort(
    (a, b) => b.excess - a.excess || a.seriesKey.localeCompare(b.seriesKey) || b.dayMs - a.dayMs,
  );
  let status: CostAnomalyStatus = "ok";
  if (judged === 0) status = "insufficient_history";
  else if (found.length > 0) status = "anomalies";
  return {
    ...header(q, days),
    status,
    judgedDayMs: newest,
    counts: {
      series: seriesSet.length,
      judged,
      anomalies: found.length,
      insufficientHistory,
      noDayData,
      mixedCurrency,
    },
    anomalies: found.slice(0, COST_ANOMALY_MAX_LISTED),
    anomaliesTruncated: Math.max(0, found.length - COST_ANOMALY_MAX_LISTED),
    gaps: skipGaps(insufficientHistory, noDayData, mixedCurrency),
  };
}
