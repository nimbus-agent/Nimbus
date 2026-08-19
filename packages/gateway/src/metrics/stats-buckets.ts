/**
 * Pure bucket arithmetic for `nimbus stats`. No database, no clock, no I/O — the caller
 * supplies `untilMs`, which is why this file's tests need no fixture.
 *
 * BUCKETS WALK BACKWARD FROM `untilMs`, and are deliberately NOT calendar-aligned. The
 * reason is not timezones — UTC would be a defensible fixed choice needing no config. It is
 * that the newest bucket must end exactly at the request time, so the freshest point covers
 * data right up to the moment of asking. Calendar alignment would truncate it at the last
 * boundary, making the newest bucket systematically short and its number systematically low
 * — the worst place for an artefact, because it is the number people read first. See the
 * design spec § 6; `--align` is a recorded follow-up, not an oversight.
 */

export type StatsBucket = { readonly startMs: number; readonly endMs: number };

/**
 * NOT a denial-of-service control — `metrics.stats` has no remote caller (no HTTP route, not
 * Tauri-exposed). This is arithmetic footgun protection: `--window 10y --bucket 1s` is 315
 * million evaluations from a plausible typo. Do not "harden" this as a security limit.
 */
export const MAX_BUCKETS = 400;

export class StatsBucketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatsBucketError";
  }
}

function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new StatsBucketError(`${label} must be a positive integer number of ms, got ${value}`);
  }
}

export function splitBuckets(untilMs: number, windowMs: number, bucketMs: number): StatsBucket[] {
  requirePositiveInteger(windowMs, "window");
  requirePositiveInteger(bucketMs, "bucket");
  if (bucketMs > windowMs) {
    throw new StatsBucketError(
      `bucket (${bucketMs}ms) is larger than window (${windowMs}ms) — ` +
        "asking for finer granularity than the window contains",
    );
  }
  const count = Math.ceil(windowMs / bucketMs);
  if (count > MAX_BUCKETS) {
    throw new StatsBucketError(
      `window/bucket yields ${count} buckets, over the ${MAX_BUCKETS} limit — widen the ` +
        "bucket or narrow the window",
    );
  }
  const sinceMs = untilMs - windowMs;
  const out: StatsBucket[] = [];
  // Built oldest-first. The FIRST bucket absorbs the remainder so the LAST one ends exactly
  // at `untilMs` — the freshest point must be complete, and a short bucket is honest only if
  // it is the oldest one, where a reader expects the window edge.
  let cursor = sinceMs;
  const remainder = windowMs % bucketMs;
  if (remainder !== 0) {
    out.push({ startMs: cursor, endMs: cursor + remainder });
    cursor += remainder;
  }
  while (cursor < untilMs) {
    out.push({ startMs: cursor, endMs: cursor + bucketMs });
    cursor += bucketMs;
  }
  return out;
}
