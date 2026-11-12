// Phase 10 FinOps: fold mapped cost points into the named series set and `__other__` (OR-FO-5).
//
// Pure (static rule D48). The named set is STABLE: a series named by an earlier sync stays named,
// a new series joins only while the set is under the cap, and everything else folds into that
// day's `__other__` row. An incremental sync sees only a few days, so re-ranking by amount on it
// would move series in and out of `__other__` and tear their history.
import {
  type CostAllocationMetadata,
  type CostPoint,
  type CostServiceId,
  costRowExternalId,
  DAY_MS,
  finalizedFor,
  OTHER_VALUE,
  type RolledCostRow,
  seriesHashOf,
  seriesKeyOf,
} from "./cost-item-contract.ts";

export interface RollupOptions {
  readonly service: CostServiceId;
  readonly scopeId: string;
  readonly maxSeries: number;
  /** The distinct `seriesHash` values already indexed for the service (empty on a first sync). */
  readonly existingSeriesHashes: ReadonlySet<string>;
  readonly syncedAt: number;
}

const MICROS = 1_000_000;

/** Sum in integer micro-units and convert once, so 0.1 + 0.2 is 0.3. */
class MicroSum {
  private micros = 0;
  count = 0;

  add(amount: number): void {
    this.micros += Math.round(amount * MICROS);
    this.count += 1;
  }

  get total(): number {
    return this.micros / MICROS;
  }
}

function commonOrNull(values: readonly (string | null)[]): string | null {
  const first = values[0] ?? null;
  return values.every((v) => v === first) ? first : null;
}

function namedSet(
  points: readonly CostPoint[],
  opts: RollupOptions,
  otherHash: string,
): Set<string> {
  const named = new Set<string>();
  for (const hash of opts.existingSeriesHashes) {
    if (hash !== otherHash) {
      named.add(hash);
    }
  }
  const totals = new Map<string, { total: number; key: string }>();
  for (const p of points) {
    if (named.has(p.seriesHash)) {
      continue;
    }
    const entry = totals.get(p.seriesHash) ?? { total: 0, key: p.seriesKey };
    entry.total += p.amount;
    totals.set(p.seriesHash, entry);
  }
  const slots = Math.max(0, opts.maxSeries - named.size);
  const candidates = [...totals.entries()].sort(
    (a, b) => b[1].total - a[1].total || (a[1].key < b[1].key ? -1 : 1),
  );
  for (const [hash] of candidates.slice(0, slots)) {
    named.add(hash);
  }
  return named;
}

interface DayBucket {
  readonly sum: MicroSum;
  readonly points: CostPoint[];
}

function rowFor(
  bucket: DayBucket,
  dayMs: number,
  opts: RollupOptions,
  identity: {
    kind: CostAllocationMetadata["dimensionKind"];
    key: string | null;
    value: string;
    hash: string;
    groupings: readonly string[];
  },
): RolledCostRow {
  const periodEndMs = dayMs + DAY_MS;
  const metadata: CostAllocationMetadata = {
    seriesKey: seriesKeyOf(opts.service, opts.scopeId, identity.kind, identity.key, identity.value),
    seriesHash: identity.hash,
    scopeId: opts.scopeId,
    dimensionKind: identity.kind,
    dimensionKey: identity.key,
    dimensionValue: identity.value,
    groupings: identity.groupings,
    periodStartMs: dayMs,
    periodEndMs,
    granularity: "day",
    amount: bucket.sum.total,
    currency: commonOrNull(bucket.points.map((p) => p.currency)),
    costKind: "unknown",
    unit: "currency",
    finalized: finalizedFor(periodEndMs, opts.syncedAt),
    provider: commonOrNull(bucket.points.map((p) => p.provider)),
    cloudService: commonOrNull(bucket.points.map((p) => p.cloudService)),
    rowCount: bucket.sum.count,
  };
  return {
    externalId: costRowExternalId(opts.scopeId, identity.hash, dayMs),
    dayMs,
    metadata,
  };
}

export interface RollupResult {
  readonly rows: RolledCostRow[];
  /** Series-days whose points carry more than one currency; no row is written for them. */
  readonly mixedCurrencyBuckets: number;
}

/** The rows to index: one per named series per UTC day, plus one `__other__` row per day. */
export function rollUpCostPoints(
  points: readonly CostPoint[],
  opts: RollupOptions,
): RolledCostRow[] {
  return rollUpCostPointsDetailed(points, opts).rows;
}

/**
 * {@link rollUpCostPoints} with the count of series-days it refused to sum. Adding amounts in two
 * currencies gives a number that is in neither, so such a bucket writes no row (a row stored with
 * `currency: null` would read as a valid total). The series identity carries no currency, so the
 * alternative of one row per currency would change the approved id contract.
 */
export function rollUpCostPointsDetailed(
  points: readonly CostPoint[],
  opts: RollupOptions,
): RollupResult {
  const otherHash = seriesHashOf("other", null, OTHER_VALUE);
  const named = namedSet(points, opts, otherHash);
  // series hash -> its first point and its day buckets; folded points go under the other hash.
  const series = new Map<string, { first: CostPoint; days: Map<number, DayBucket> }>();
  for (const p of points) {
    const hash = named.has(p.seriesHash) ? p.seriesHash : otherHash;
    const entry = series.get(hash) ?? { first: p, days: new Map<number, DayBucket>() };
    const bucket = entry.days.get(p.dayMs) ?? { sum: new MicroSum(), points: [] };
    bucket.sum.add(p.amount);
    bucket.points.push(p);
    entry.days.set(p.dayMs, bucket);
    series.set(hash, entry);
  }
  const rows: RolledCostRow[] = [];
  let mixedCurrencyBuckets = 0;
  for (const [hash, { first, days }] of series) {
    const identity =
      hash === otherHash
        ? {
            kind: "other" as const,
            key: null,
            value: OTHER_VALUE,
            hash,
            groupings: first.groupings,
          }
        : {
            kind: first.dimensionKind,
            key: first.dimensionKey,
            value: first.dimensionValue,
            hash,
            groupings: first.groupings,
          };
    for (const [dayMs, bucket] of days) {
      if (new Set(bucket.points.map((p) => p.currency)).size > 1) {
        mixedCurrencyBuckets += 1;
        continue;
      }
      rows.push(rowFor(bucket, dayMs, opts, identity));
    }
  }
  rows.sort((a, b) => a.dayMs - b.dayMs || (a.externalId < b.externalId ? -1 : 1));
  return { rows, mixedCurrencyBuckets };
}
