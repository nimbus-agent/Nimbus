/**
 * The gate decision. ONLY `regression` can fail the run.
 *
 * `queue`, `dagWait` and `unstable` are deliberately observation-only: none is
 * caused by the change under test. Queue wait moves with how many PRs happen to
 * be open, and a flaky job is flaky regardless of the diff — failing a
 * contributor for either would report a condition they cannot fix, which the
 * infrastructure roadmap names as the way a gate becomes one everybody ignores.
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
