// Phase 7 (the Cost Pack, slice 6): the bucket loop the AI-provider cost mappers share (OpenAI costs, Anthropic
// cost report). Pure (static D48). Each vendor supplies how a bucket names its day and how one result row becomes
// a line; this walks every bucket of a month's pages, drops and counts what it cannot use, and sums rows of one day
// and grain so the stored unique key (`cost_line_grain`) never collides.
import { type CostLine, costLineGrainHash, mergeMeasures } from "./cost-line.ts";

export type CostDropReason = "malformed" | "outside_month";

export interface CostMapResult {
  readonly lines: readonly CostLine[];
  /** How many result rows the buckets held, kept or not (an all-dropped non-empty report is a retry). */
  readonly rows: number;
  readonly dropped: Readonly<Record<CostDropReason, number>>;
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const MAX_TEXT = 256;
export const costText = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 && v.length <= MAX_TEXT ? v : null;

/** A nullable id field: null or absent is `null`; anything else must be plain text, or the row is malformed. */
export function nullableId(v: unknown): { ok: true; value: string | null } | { ok: false } {
  if (v === null || v === undefined) return { ok: true, value: null };
  const t = costText(v);
  return t === null ? { ok: false } : { ok: true, value: t };
}

export interface CostBucketVendor {
  /** The UTC day a bucket starts on, or null when it names none. */
  readonly dayOf: (bucket: Record<string, unknown>) => string | null;
  /** One result row as a line on `day` of `month`, or null when the row is malformed. */
  readonly lineOf: (day: string, month: string, row: Record<string, unknown>) => CostLine | null;
}

/** The lines of every bucket of one month (`YYYY-MM`), up to `lastDay` (`YYYY-MM-DD`). */
export function mapCostBuckets(
  vendor: CostBucketVendor,
  buckets: readonly unknown[],
  month: string,
  lastDay: string,
): CostMapResult {
  const dropped: Record<CostDropReason, number> = { malformed: 0, outside_month: 0 };
  const merged = new Map<string, CostLine>();
  let rows = 0;
  for (const b of buckets) {
    const results = isRecord(b) && Array.isArray(b["results"]) ? (b["results"] as unknown[]) : null;
    if (!isRecord(b) || results === null) {
      rows++;
      dropped.malformed++;
      continue;
    }
    const day = vendor.dayOf(b);
    for (const r of results) {
      rows++;
      if (day === null || !isRecord(r)) {
        dropped.malformed++;
        continue;
      }
      if (day.slice(0, 7) !== month || day > lastDay) {
        dropped.outside_month++;
        continue;
      }
      const line = vendor.lineOf(day, month, r);
      if (line === null) {
        dropped.malformed++;
        continue;
      }
      const key = `${day}|${costLineGrainHash(line)}`;
      const prior = merged.get(key);
      merged.set(
        key,
        prior === undefined
          ? line
          : {
              ...prior,
              billedCost: prior.billedCost + line.billedCost,
              effectiveCost: (prior.effectiveCost ?? 0) + (line.effectiveCost ?? 0),
              ...mergeMeasures(prior, line),
            },
      );
    }
  }
  return { lines: [...merged.values()], rows, dropped };
}
