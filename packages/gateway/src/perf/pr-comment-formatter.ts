import type { HistoryLine, HistoryLineSurface } from "./history-line.ts";
import { isFloorMetric, type SurfaceComparison } from "./threshold-comparator.ts";

export const COMMENT_MARKER_PREFIX = "nimbus-perf-delta";

function metricToHistoryField(metric: SurfaceComparison["metric"]): keyof HistoryLineSurface {
  switch (metric) {
    case "p95_ms":
      return "p95_ms";
    case "p50_ms":
      return "p50_ms";
    case "throughput_per_sec":
      return "throughput_per_sec";
    case "rss_bytes_p95":
      return "rss_bytes_p95";
    case "tokens_per_sec":
      return "tokens_per_sec";
    case "first_token_ms":
      return "first_token_ms";
  }
}

function readSurfaceMetric(
  line: HistoryLine,
  surfaceId: string,
  metric: SurfaceComparison["metric"],
): number | undefined {
  const surface = line.surfaces[surfaceId as keyof HistoryLine["surfaces"]];
  if (surface === undefined) return undefined;
  const v = (surface as unknown as Record<string, unknown>)[metricToHistoryField(metric)];
  return typeof v === "number" ? v : undefined;
}

function fmtNum(n: number | undefined): string {
  if (n === undefined) return "—";
  if (n >= 1_000_000) return n.toExponential(2);
  return Number.isInteger(n) ? n.toString() : n.toFixed(2);
}

function statusCell(c: SurfaceComparison): string {
  switch (c.status.kind) {
    case "pass":
      return "✅ pass";
    case "absolute-fail": {
      const op = isFloorMetric(c.metric) ? "<" : ">";
      return `❌ absolute-fail (${fmtNum(c.status.measured)} ${op} ${fmtNum(c.status.threshold)})`;
    }
    case "delta-fail":
      return `⚠️ delta-fail (floor ${c.status.floorPct.toFixed(1)}%)`;
    case "no-baseline":
      return "🆕 no-baseline";
    case "skipped":
      return `⏭ skipped (${c.status.reason})`;
  }
}

function deltaCell(
  c: SurfaceComparison,
  current: number | undefined,
  previous: number | undefined,
): string {
  if (c.status.kind === "delta-fail") {
    return `${c.status.deltaPct >= 0 ? "+" : ""}${c.status.deltaPct.toFixed(1)}%`;
  }
  if (current !== undefined && previous !== undefined && previous > 0) {
    const pct = ((current - previous) / previous) * 100;
    return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
  }
  return "—";
}

export function formatPrComment(
  comparisons: readonly SurfaceComparison[],
  current: HistoryLine,
  previous: HistoryLine | null,
): string {
  const baselineNote =
    previous === null
      ? "> First run on this runner; no delta available yet. The artifact is uploaded; subsequent runs will diff against it."
      : `> Compared against main artifact \`${previous.nimbus_git_sha}\` (${previous.timestamp}).`;
  const lines: string[] = [
    `<!-- ${COMMENT_MARKER_PREFIX}:${current.runner} -->`,
    `### Performance benchmarks — ${current.runner}`,
    "",
    baselineNote,
    "",
    "| Surface | Metric | Previous | Current | Δ | Status |",
    "|---|---|---|---|---|---|",
  ];
  for (const c of comparisons) {
    const cur = readSurfaceMetric(current, c.surfaceId, c.metric);
    const prev = previous === null ? undefined : readSurfaceMetric(previous, c.surfaceId, c.metric);
    lines.push(
      `| ${c.surfaceId} | ${c.metric} | ${fmtNum(prev)} | ${fmtNum(cur)} | ${deltaCell(c, cur, prev)} | ${statusCell(c)} |`,
    );
  }
  return lines.join("\n");
}
