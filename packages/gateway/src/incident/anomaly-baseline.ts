/**
 * The anomaly baseline's score (Phase 10 IC8, incident-engine spec § 5.8): pure. A bucket is scored against the
 * series' hourly buckets of the 14 days before it, and only once at least {@link MIN_BASELINE_BUCKETS} (7 days) of
 * them exist; fewer is "not enough history", never "no anomaly". The deviation is divided by the standard deviation
 * floored at 1, so a series that has always been zero needs `anomaly_z` events in one hour to be a finding, not one.
 * Only an increase counts.
 */

export const BUCKET_MS = 3_600_000;
export const BASELINE_WINDOW_MS = 14 * 86_400_000;
export const MIN_BASELINE_BUCKETS = 7 * 24;
const SD_FLOOR = 1;

export type BucketScore = {
  readonly z: number;
  readonly mean: number;
  readonly sd: number;
  readonly baselineBuckets: number;
};

/** The score of `value` against `history`, or null when the history is shorter than 7 days of buckets. */
export function scoreBucket(history: readonly number[], value: number): BucketScore | null {
  if (history.length < MIN_BASELINE_BUCKETS) return null;
  const mean = history.reduce((a, b) => a + b, 0) / history.length;
  const variance = history.reduce((a, b) => a + (b - mean) ** 2, 0) / history.length;
  const sd = Math.sqrt(variance);
  return { z: (value - mean) / Math.max(sd, SD_FLOOR), mean, sd, baselineBuckets: history.length };
}

/** True when the score is an anomaly at threshold `z`: at or above it, and an increase. */
export function isAnomalous(score: BucketScore | null, value: number, z: number): boolean {
  return score !== null && value > score.mean && score.z >= z;
}

/** The start of the hour bucket that contains `ms`. */
export function bucketStart(ms: number): number {
  return Math.floor(ms / BUCKET_MS) * BUCKET_MS;
}
