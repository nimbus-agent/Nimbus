// Phase 10 FinOps: the pure reader of a daily cost series (spec section 5.1).
//
// Confined by static rule D48: no network, no connector, no model, and it writes nothing. A later
// detector reads cost data only through this function. It reads `item` rows through the
// `json_extract` form the index-lane census can see.
import type { Database } from "bun:sqlite";
import { COST_SERVICE_IDS, DAY_MS, isCostServiceId, startOfUtcDay } from "./cost-item-contract.ts";

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

// The type is a literal (it is COST_ALLOCATION_TYPE) so the index-lane census can scope the reads.
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
          AND type = 'cost_allocation'
          AND json_extract(metadata, '$.seriesKey') = ?
          AND json_extract(metadata, '$.periodStartMs') BETWEEN ? AND ?
        ORDER BY day ASC`,
    )
    .all(service, query.seriesKey, from, to) as Row[];
  const points = rows
    .map((r) => ({ dayMs: r.day, amount: r.amount, finalized: r.finalized === 1 }))
    .filter((p) => query.finalizedOnly !== true || p.finalized);
  return { points, gaps: gapsBetween(points) };
}

export interface CostWindowQuery {
  /** One cost service, or every cost service when absent. */
  readonly service?: string;
  readonly fromMs: number;
  readonly toMs: number;
  readonly finalizedOnly?: boolean;
}

export interface CostWindowSeries {
  readonly seriesKey: string;
  /** The grouping value the row was named by (a vendor string: never trusted for display). */
  readonly name: string;
  /** Every distinct non-null currency seen in the window (one is the normal case). */
  readonly currencies: readonly string[];
  readonly points: readonly CostSeriesPoint[];
}

interface WindowRow {
  key: string;
  name: string | null;
  currency: string | null;
  day: number;
  amount: number;
  finalized: number;
}

/** What the index holds, for a caller that must tell "no cost data" from "no complete day yet". */
export interface CostDataExtent {
  readonly rowCount: number;
  /** The newest UTC day with a finalized row; null when there is none. */
  readonly latestFinalizedDayMs: number | null;
}

function serviceFilter(service: string | undefined): readonly string[] {
  if (service === undefined) return COST_SERVICE_IDS;
  return isCostServiceId(service) ? [service] : [];
}

function inList(values: readonly string[]): string {
  return values.map(() => "?").join(", ");
}

/** How many cost rows exist and the newest finalized day (the day a detector may judge). */
export function readCostDataExtent(db: Database, service?: string): CostDataExtent {
  const services = serviceFilter(service);
  if (services.length === 0) return { rowCount: 0, latestFinalizedDayMs: null };
  const row = db
    .query(
      `SELECT COUNT(*) AS n,
              MAX(CASE WHEN json_extract(metadata, '$.finalized') = 1
                       THEN json_extract(metadata, '$.periodStartMs') END) AS latest
         FROM item
        WHERE service IN (${inList(services)})
          AND type = 'cost_allocation'`,
    )
    .get(...services) as { n: number; latest: number | null };
  return { rowCount: row.n, latestFinalizedDayMs: row.latest };
}

/**
 * Every series with a row in `[fromMs, toMs]` (UTC days, inclusive), one read for the lot: the detector
 * must not run one scan of the index per series. Series are ordered by key, points by day.
 */
export function readCostSeriesWindow(db: Database, query: CostWindowQuery): CostWindowSeries[] {
  const services = serviceFilter(query.service);
  const from = startOfUtcDay(query.fromMs);
  const to = startOfUtcDay(query.toMs);
  if (services.length === 0 || to < from) return [];
  const rows = db
    .query(
      `SELECT json_extract(metadata, '$.seriesKey') AS key,
              json_extract(metadata, '$.dimensionValue') AS name,
              json_extract(metadata, '$.currency') AS currency,
              json_extract(metadata, '$.periodStartMs') AS day,
              json_extract(metadata, '$.amount') AS amount,
              json_extract(metadata, '$.finalized') AS finalized
         FROM item
        WHERE service IN (${inList(services)})
          AND type = 'cost_allocation'
          AND json_extract(metadata, '$.periodStartMs') BETWEEN ? AND ?
        ORDER BY key ASC, day ASC`,
    )
    .all(...services, from, to) as WindowRow[];
  const out: {
    seriesKey: string;
    name: string;
    currencies: Set<string>;
    points: CostSeriesPoint[];
  }[] = [];
  for (const r of rows) {
    if (query.finalizedOnly === true && r.finalized !== 1) continue;
    let cur = out.at(-1);
    if (cur?.seriesKey !== r.key) {
      cur = { seriesKey: r.key, name: r.name ?? "", currencies: new Set(), points: [] };
      out.push(cur);
    }
    if (r.currency !== null) cur.currencies.add(r.currency);
    cur.points.push({ dayMs: r.day, amount: r.amount, finalized: r.finalized === 1 });
  }
  // Code-unit order (what a bare `.sort()` gives), spelled out: deterministic, locale-independent.
  const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : Number(a > b));
  return out.map((s) => ({ ...s, currencies: [...s.currencies].sort(byCodeUnit) }));
}
