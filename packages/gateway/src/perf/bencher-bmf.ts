import type { HistoryLine, HistoryLineSurface } from "./history-line.ts";
import { SLO_THRESHOLDS, type SloThreshold, thresholdsBySurface } from "./slo-thresholds.ts";

/** One Bencher Metric Format measure value (we emit only the central `value`). */
export interface BmfMetric {
  value: number;
}

/** Bencher Metric Format: { benchmarkName: { measureSlug: { value } } }. */
export type BmfReport = Record<string, Record<string, BmfMetric>>;

/**
 * Maps each SloThreshold metric to its Bencher Measure slug. The slug's
 * lower-vs-higher-is-better direction is configured once on the Bencher project
 * (spec §6): latency/memory/first_token are lower-is-better; throughput/tokens
 * are higher-is-better — matching `isFloorMetric`.
 */
const MEASURE_BY_METRIC: Record<SloThreshold["metric"], string> = {
  p95_ms: "latency",
  p50_ms: "latency",
  rss_bytes_p95: "memory",
  throughput_per_sec: "throughput",
  tokens_per_sec: "tokens",
  first_token_ms: "first_token",
};

/**
 * Map the latest HistoryLine into a Bencher Metric Format report for every
 * `trend`-class surface carrying a finite metric value. Unlike the
 * github-action-benchmark emitter (`toBenchmarkPoints`), this includes ALL
 * metric kinds — throughput/tokens trend surfaces are charted here.
 * Stub surfaces (`samples_count === 0`) and non-finite values are skipped.
 * An all-stub line yields an empty `{}` (the workflow skips publishing it).
 * Metric names equal `HistoryLineSurface` field names, so `surface[metric]`
 * reads the value directly.
 */
export function toBencherBmf(line: HistoryLine): BmfReport {
  const bySurface = thresholdsBySurface();
  const out: BmfReport = {};
  for (const slo of SLO_THRESHOLDS) {
    if (bySurface.get(slo.surfaceId)?.gateClass !== "trend") continue;
    const surface: HistoryLineSurface | undefined = line.surfaces[slo.surfaceId];
    if (surface === undefined || surface.samples_count === 0) continue;
    const raw = surface[slo.metric];
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    out[slo.surfaceId] = { [MEASURE_BY_METRIC[slo.metric]]: { value: raw } };
  }
  return out;
}
