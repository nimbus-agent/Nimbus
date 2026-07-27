/**
 * Pure reduction from raw observations to per-key statistics.
 *
 * Medians everywhere, never means: a single contended run produced a 58-minute
 * observation in the sample that motivated this gate, and a mean would let that
 * one outlier redefine the job.
 */

import type { JobObservation, KeySummary } from "./types.ts";

export function observationKey(o: JobObservation): string {
  return `${o.repo} :: ${o.workflow} :: ${o.job}`;
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2 === 1) return s[mid] as number;
  return ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/**
 * 90th percentile by nearest-rank. On a small sample this collapses to the max,
 * which is the honest answer: with three observations there is no distinguishing
 * a p90 from a maximum.
 */
export function p90(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const rank = Math.ceil(0.9 * s.length);
  return s[Math.min(rank, s.length) - 1] as number;
}

export function summarize(obs: readonly JobObservation[]): Map<string, KeySummary> {
  const grouped = new Map<string, JobObservation[]>();
  for (const o of obs) {
    const k = observationKey(o);
    const list = grouped.get(k) ?? [];
    list.push(o);
    grouped.set(k, list);
  }

  const out = new Map<string, KeySummary>();
  for (const [key, list] of grouped) {
    const execs = list.map((o) => o.exec);
    const execMedian = median(execs);
    out.set(key, {
      key,
      samples: list.length,
      execMedian,
      execSpread: Math.max(0, p90(execs) - execMedian),
      queueMedian: median(list.map((o) => o.queue)),
      dagWaitMedian: median(list.map((o) => o.dagWait)),
    });
  }
  return out;
}
