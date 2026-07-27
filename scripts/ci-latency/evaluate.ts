/**
 * The gate decision. ONLY a `regression` finding can fail the run.
 *
 * `insufficient-data`, `new-key`, `stale-baseline-entry` and `unstable` are
 * reported and never fail, and `queue`/`dagWait` are surfaced by the shell
 * rather than classified here at all. None of them is caused by the change
 * under test — queue wait moves with how many runs are in flight — and the
 * infrastructure roadmap names reporting an unfixable condition as the way a
 * gate becomes one everybody ignores.
 *
 * `unstable` is a LABEL on a key, NOT an exemption — a deliberate choice, since
 * the alternative is worse. An unstable key can still produce a `regression`,
 * because its allowed band is already its own (wide) historical spread: the
 * noisiest job in this repo carries a ~10-minute band, so it can only fail by
 * getting more than ten minutes slower, which is precisely when it should. The
 * opposite rule — exempting unstable keys — would hand permanent immunity to
 * the slowest, most-worth-watching jobs, which is how a latency gate ends up
 * measuring only the jobs that never mattered. `evaluate.test.ts` pins this.
 */

import { MIN_ABSOLUTE_DELTA_MIN, MIN_SAMPLES, UNSTABLE_SPREAD_RATIO } from "./constants.ts";
import type { CheckResult, Finding, KeySummary, LatencyBaseline } from "./types.ts";

const r1 = (n: number): string => n.toFixed(1);

export function evaluate(
  summaries: ReadonlyMap<string, KeySummary>,
  baseline: LatencyBaseline,
): CheckResult {
  const findings: Finding[] = [];

  for (const [key, s] of summaries) {
    if (s.execSpread > s.execMedian * UNSTABLE_SPREAD_RATIO && s.execMedian > 0) {
      findings.push({
        key,
        kind: "unstable",
        detail: `spread ${r1(s.execSpread)}m on a ${r1(s.execMedian)}m median — flaky, not a regression`,
      });
    }

    if (s.samples < MIN_SAMPLES) {
      findings.push({
        key,
        kind: "insufficient-data",
        detail: `${s.samples} sample(s), need ${MIN_SAMPLES} — skipped, and no retry creates more history`,
      });
      continue;
    }

    const prev = baseline.entries.get(key);
    if (!prev) {
      findings.push({
        key,
        kind: "new-key",
        detail: `not in the baseline (median ${r1(s.execMedian)}m) — recorded on the next --update-baseline`,
      });
      continue;
    }

    const allowed = Math.max(MIN_ABSOLUTE_DELTA_MIN, prev.execSpread);
    if (s.execMedian > prev.execMedian + allowed) {
      findings.push({
        key,
        kind: "regression",
        detail: `${r1(s.execMedian)}m vs baseline ${r1(prev.execMedian)}m (+${r1(s.execMedian - prev.execMedian)}m, allowed +${r1(allowed)}m)`,
      });
    }
  }

  for (const key of baseline.entries.keys()) {
    if (!summaries.has(key)) {
      findings.push({
        key,
        kind: "stale-baseline-entry",
        detail: "in the baseline but not observed — renamed or deleted; fix with --update-baseline",
      });
    }
  }

  return { findings, regressions: findings.filter((f) => f.kind === "regression") };
}
