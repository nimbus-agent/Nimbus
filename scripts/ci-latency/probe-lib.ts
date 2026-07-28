/**
 * Pure helpers for the two P4b diagnostic probes.
 *
 * They live apart from the probes so the arithmetic is unit-testable without a
 * network call. The probes themselves are thin: fetch, map, print.
 */

export interface CompletedJob {
  name: string;
  completed_at: string | null;
}

export interface RunningJob {
  started_at: string;
  completed_at: string | null;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length / 2;
  if (s.length % 2 === 1) return s[Math.floor(mid)] ?? 0;
  return ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/** Whole minutes from `b` to `a`. Unparseable input yields 0, never NaN. */
export function minutesBetween(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
  return (ta - tb) / 60_000;
}

/**
 * The upstream job whose completion gated a dependent job — i.e. the last one
 * to finish. Returns null when nothing has completed.
 */
export function bindingUpstream(jobs: CompletedJob[]): CompletedJob | null {
  let best: CompletedJob | null = null;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const j of jobs) {
    if (j.completed_at === null) continue;
    const at = Date.parse(j.completed_at);
    if (Number.isNaN(at) || at <= bestAt) continue;
    bestAt = at;
    best = j;
  }
  return best;
}

/** How many jobs were running at each whole-minute offset from `runStartedAt`. */
export function concurrencySeries(jobs: RunningJob[], runStartedAt: string): number[] {
  const t0 = Date.parse(runStartedAt);
  const usable = jobs.filter((j) => j.completed_at !== null);
  if (Number.isNaN(t0) || usable.length === 0) return [];
  const end = Math.max(...usable.map((j) => Date.parse(j.completed_at ?? "")));
  if (!Number.isFinite(end)) return [];
  const span = Math.ceil((end - t0) / 60_000);
  const series: number[] = [];
  for (let m = 0; m <= span; m++) {
    const at = t0 + m * 60_000;
    series.push(
      usable.filter((j) => Date.parse(j.started_at) <= at && Date.parse(j.completed_at ?? "") > at)
        .length,
    );
  }
  return series;
}
