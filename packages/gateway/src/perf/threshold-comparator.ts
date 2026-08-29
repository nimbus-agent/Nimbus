import type { HistoryLine, HistoryLineSurface } from "./history-line.ts";
import type { SloThreshold } from "./slo-thresholds.ts";
import type { BenchSurfaceId, RunnerKind } from "./types.ts";

export type ComparisonStatus =
  | { kind: "pass" }
  | { kind: "absolute-fail"; measured: number; threshold: number }
  | { kind: "delta-fail"; previous: number; current: number; deltaPct: number; floorPct: number }
  | { kind: "skipped"; reason: "tbd-c2" | "trend-only" | "reference-only" | "stub" }
  | { kind: "no-baseline"; current: number };

export interface SurfaceComparison {
  surfaceId: BenchSurfaceId;
  metric: SloThreshold["metric"];
  status: ComparisonStatus;
}

function readMetric(
  s: HistoryLineSurface | undefined,
  metric: SloThreshold["metric"],
): number | undefined {
  if (s === undefined) return undefined;
  switch (metric) {
    case "p95_ms":
      return s.p95_ms;
    case "p50_ms":
      return s.p50_ms;
    case "throughput_per_sec":
      return s.throughput_per_sec;
    case "rss_bytes_p95":
      return s.rss_bytes_p95;
    case "tokens_per_sec":
      return s.tokens_per_sec;
    case "first_token_ms":
      return s.first_token_ms;
  }
}

function isStub(s: HistoryLineSurface | undefined): boolean {
  return s?.samples_count === 0;
}

export function isFloorMetric(metric: SloThreshold["metric"]): boolean {
  return metric === "throughput_per_sec" || metric === "tokens_per_sec";
}

function classifySkip(slo: SloThreshold, runner: RunnerKind): ComparisonStatus | null {
  // On the consistent-hardware reference runner, every class with a refMax is evaluated.
  if (runner === "reference-m1air") {
    if (slo.gateClass === "reference" && slo.refMax === undefined) {
      return { kind: "skipped", reason: "reference-only" };
    }
    if (slo.ghaMax === "tbd-c2" && slo.refMax === undefined) {
      return { kind: "skipped", reason: "tbd-c2" };
    }
    return null;
  }
  // On any GHA shared runner, only gate-class surfaces are evaluated.
  if (slo.gateClass === "reference" || slo.ghaMax === "skipped") {
    return { kind: "skipped", reason: "reference-only" };
  }
  if (slo.gateClass === "trend") {
    return { kind: "skipped", reason: "trend-only" };
  }
  if (slo.ghaMax === "tbd-c2") {
    return { kind: "skipped", reason: "tbd-c2" };
  }
  return null;
}

function pickAbsoluteThreshold(slo: SloThreshold, runner: RunnerKind): number | undefined {
  if (runner === "reference-m1air") return slo.refMax;
  return typeof slo.ghaMax === "number" ? slo.ghaMax : undefined;
}

function compareOne(
  slo: SloThreshold,
  current: HistoryLineSurface | undefined,
  previous: HistoryLineSurface | undefined | null,
  runner: RunnerKind,
): ComparisonStatus {
  const skipReason = classifySkip(slo, runner);
  if (skipReason !== null) return skipReason;
  if (isStub(current)) return { kind: "skipped", reason: "stub" };

  const measured = readMetric(current, slo.metric);
  if (measured === undefined) {
    return previous == null ? { kind: "no-baseline", current: 0 } : { kind: "pass" };
  }

  const threshold = pickAbsoluteThreshold(slo, runner);
  if (threshold !== undefined) {
    const absoluteFail = isFloorMetric(slo.metric) ? measured < threshold : measured > threshold;
    if (absoluteFail) {
      return { kind: "absolute-fail", measured, threshold };
    }
  }

  if (previous == null) return { kind: "no-baseline", current: measured };
  const prev = readMetric(previous, slo.metric);
  if (prev === undefined || prev <= 0) return { kind: "no-baseline", current: measured };

  const deltaPct = ((measured - prev) / prev) * 100;
  const regressionPct = isFloorMetric(slo.metric) ? -deltaPct : deltaPct;
  const effectiveFloorPct = effectiveNoiseFloorPct(slo, prev);
  if (regressionPct > effectiveFloorPct) {
    return {
      kind: "delta-fail",
      previous: prev,
      current: measured,
      deltaPct,
      floorPct: effectiveFloorPct,
    };
  }
  return { kind: "pass" };
}

/**
 * The noise floor a regression must clear, as a percentage of `baseline`.
 *
 * Combines the surface's relative floor with its ABSOLUTE one: on a fast surface a 40 % swing
 * can be a handful of milliseconds of scheduler noise, so `noiseFloorAbs` raises the bar when
 * the baseline is small. Exported so the drift detector uses the SAME formula rather than a
 * second copy -- it previously used a hardcoded 10 % that ignored both fields, which is what
 * filed #1308 and #1309 against surfaces whose own declared floor is 40 %.
 */
export function effectiveNoiseFloorPct(slo: SloThreshold, baseline: number): number {
  if (baseline <= 0) return slo.noiseFloorPct;
  return Math.max(slo.noiseFloorPct, (slo.noiseFloorAbs / baseline) * 100);
}

export function compareAgainstHistory(
  current: HistoryLine,
  previous: HistoryLine | null,
  slo: readonly SloThreshold[],
  runner: RunnerKind,
): SurfaceComparison[] {
  const out: SurfaceComparison[] = [];
  for (const row of slo) {
    const cur = current.surfaces[row.surfaceId];
    const prev = previous?.surfaces[row.surfaceId];
    out.push({
      surfaceId: row.surfaceId,
      metric: row.metric,
      status: compareOne(row, cur, prev, runner),
    });
  }
  return out;
}

export function isFailingComparison(c: SurfaceComparison, slo: SloThreshold): boolean {
  if (slo.gateClass !== "gate") return false;
  return c.status.kind === "absolute-fail" || c.status.kind === "delta-fail";
}
