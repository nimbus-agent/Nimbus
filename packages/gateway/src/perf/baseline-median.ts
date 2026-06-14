import type { HistoryLine, HistoryLineSurface } from "./history-line.ts";
import type { BenchSurfaceId } from "./types.ts";

/**
 * Numeric metric fields of a surface that participate in median aggregation. `samples_count` is
 * handled separately (it gates the stub check); the bookkeeping fields (`raw_samples`,
 * `busy_retries`, `stub_reason`) are intentionally excluded.
 */
const NUMERIC_SURFACE_METRICS = [
  "p50_ms",
  "p95_ms",
  "p99_ms",
  "max_ms",
  "throughput_per_sec",
  "tokens_per_sec",
  "first_token_ms",
  "rss_bytes_p95",
] as const satisfies readonly (keyof HistoryLineSurface)[];

/** Median of a non-empty list. Even-length lists average the two middle values. */
export function medianOf(values: readonly number[]): number {
  if (values.length === 0) throw new Error("medianOf: empty input");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * Collapse N recent baseline history lines into one synthetic "median baseline" so the delta gate
 * compares the current run against the run-over-run median rather than a single previous run. A
 * lone lucky-fast (or unlucky-slow) prior run would otherwise poison the comparison — observed on
 * `main` when one fast cold-start became the baseline and the next two commits delta-failed against
 * it with no code change.
 *
 * Per surface, each numeric metric is the median across the runs that report a non-stub value for
 * it; a surface with no usable (non-stub) samples in any run is omitted. Identifying metadata is
 * carried forward from the newest run (lines are expected newest-first). Returns null when there
 * are no input lines (first-run, or all artifacts missing/unreadable).
 */
export function medianBaseline(lines: readonly HistoryLine[]): HistoryLine | null {
  const newest = lines[0];
  if (newest === undefined) return null;

  const surfaceIds = new Set<BenchSurfaceId>();
  for (const l of lines) {
    for (const id of Object.keys(l.surfaces) as BenchSurfaceId[]) surfaceIds.add(id);
  }

  const surfaces: Partial<Record<BenchSurfaceId, HistoryLineSurface>> = {};
  for (const id of surfaceIds) {
    const present = lines
      .map((l) => l.surfaces[id])
      .filter((s): s is HistoryLineSurface => s !== undefined && s.samples_count > 0);
    if (present.length === 0) continue;

    const merged: HistoryLineSurface = {
      samples_count: medianOf(present.map((s) => s.samples_count)),
    };
    for (const metric of NUMERIC_SURFACE_METRICS) {
      const vals = present.map((s) => s[metric]).filter((v): v is number => typeof v === "number");
      if (vals.length > 0) merged[metric] = medianOf(vals);
    }
    surfaces[id] = merged;
  }

  return { ...newest, surfaces };
}
