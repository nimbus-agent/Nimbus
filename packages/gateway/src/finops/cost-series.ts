// Phase 10 FinOps: the pure reader of a daily cost series (spec section 5.1).
//
// Confined by static rule D48: no network, no connector, no model, and it writes nothing. A later
// detector reads cost data only through this function. It reads `item` rows through the
// `json_extract` form the index-lane census can see.
import type { Database } from "bun:sqlite";
import {
  COST_ALLOCATION_TYPE,
  DAY_MS,
  isCostServiceId,
  startOfUtcDay,
} from "./cost-item-contract.ts";

export interface CostSeriesQuery {
  readonly seriesKey: string;
  readonly fromMs: number;
  readonly toMs: number;
  /** Drop days that may still be restated by the vendor. */
  readonly finalizedOnly?: boolean;
}

export interface CostSeriesPoint {
  readonly dayMs: number;
  readonly amount: number;
  readonly finalized: boolean;
}

export interface CostSeries {
  readonly points: readonly CostSeriesPoint[];
  /** UTC days with no point between the first and the last point returned. */
  readonly gaps: readonly number[];
}

interface Row {
  day: number;
  amount: number;
  finalized: number;
}

function gapsBetween(points: readonly CostSeriesPoint[]): number[] {
  const gaps: number[] = [];
  let prev: CostSeriesPoint | undefined;
  for (const point of points) {
    if (prev !== undefined) {
      for (let day = prev.dayMs + DAY_MS; day < point.dayMs; day += DAY_MS) {
        gaps.push(day);
      }
    }
    prev = point;
  }
  return gaps;
}

/**
 * The daily series of one `seriesKey` between `fromMs` and `toMs` (UTC days, both inclusive). The
 * service is the key's first part and must be one of the five cost services; any other key reads
 * nothing. Bound parameters only (I9).
 */
export function readCostSeries(db: Database, query: CostSeriesQuery): CostSeries {
  const service = query.seriesKey.split("|", 1)[0] ?? "";
  const from = startOfUtcDay(query.fromMs);
  const to = startOfUtcDay(query.toMs);
  if (!isCostServiceId(service) || to < from) {
    return { points: [], gaps: [] };
  }
  const rows = db
    .query(
      `SELECT json_extract(metadata, '$.periodStartMs') AS day,
              json_extract(metadata, '$.amount') AS amount,
              json_extract(metadata, '$.finalized') AS finalized
         FROM item
        WHERE service = ?
          AND type = ?
          AND json_extract(metadata, '$.seriesKey') = ?
          AND json_extract(metadata, '$.periodStartMs') BETWEEN ? AND ?
        ORDER BY day ASC`,
    )
    .all(service, COST_ALLOCATION_TYPE, query.seriesKey, from, to) as Row[];
  const points = rows
    .map((r) => ({ dayMs: r.day, amount: r.amount, finalized: r.finalized === 1 }))
    .filter((p) => query.finalizedOnly !== true || p.finalized);
  return { points, gaps: gapsBetween(points) };
}
