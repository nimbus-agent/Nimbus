#!/usr/bin/env bun

import { writeFileSync } from "node:fs";

import type {
  HistoryLine,
  HistoryLineSurface,
} from "../../packages/gateway/src/perf/history-line.ts";
import {
  SLO_THRESHOLDS,
  thresholdsBySurface,
} from "../../packages/gateway/src/perf/slo-thresholds.ts";
import { parseLastHistoryLine } from "./history-jsonl.ts";

/** A github-action-benchmark `customSmallerIsBetter` data point. */
export interface BenchmarkPoint {
  name: string;
  unit: string;
  value: number;
}

/**
 * Smaller-is-better trend metrics emitted this phase. Throughput trend surfaces
 * (`throughput_per_sec` / `tokens_per_sec`) are bigger-is-better and deferred to
 * a separate `customBiggerIsBetter` file (Phase 2) — intentionally not here.
 */
const TREND_METRICS: ReadonlyArray<{
  metric: "p95_ms" | "rss_bytes_p95";
  field: keyof HistoryLineSurface;
  label: string;
  unit: string;
}> = [
  { metric: "p95_ms", field: "p95_ms", label: "p95", unit: "ms" },
  { metric: "rss_bytes_p95", field: "rss_bytes_p95", label: "rss_p95", unit: "bytes" },
];

/**
 * Map the latest HistoryLine into github-action-benchmark points for every
 * `trend`-class surface that carries a finite smaller-is-better metric value.
 * Deterministic: iterates `SLO_THRESHOLDS` in declared order.
 */
export function toBenchmarkPoints(line: HistoryLine): BenchmarkPoint[] {
  const bySurface = thresholdsBySurface();
  const out: BenchmarkPoint[] = [];
  for (const slo of SLO_THRESHOLDS) {
    if (bySurface.get(slo.surfaceId)?.gateClass !== "trend") continue;
    const surface = line.surfaces[slo.surfaceId];
    if (surface === undefined || surface.samples_count === 0) continue;
    for (const trend of TREND_METRICS) {
      if (trend.metric !== slo.metric) continue;
      const raw = surface[trend.field];
      if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
      out.push({ name: `${slo.surfaceId} ${trend.label}`, unit: trend.unit, value: raw });
    }
  }
  return out;
}

function takeFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

export async function runEmitBenchmarkJsonMain(args: string[]): Promise<number> {
  const inPath = takeFlag(args, "--in");
  const outPath = takeFlag(args, "--out");
  if (inPath === undefined || outPath === undefined) {
    process.stderr.write(
      "usage: emit-benchmark-json.ts --in <run-history.jsonl> --out <points.json>\n",
    );
    return 2;
  }
  try {
    const text = await Bun.file(inPath).text();
    const line = parseLastHistoryLine(text);
    const points = toBenchmarkPoints(line);
    writeFileSync(outPath, `${JSON.stringify(points, null, 2)}\n`, "utf8");
    process.stdout.write(`wrote ${points.length} trend point(s) to ${outPath}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runEmitBenchmarkJsonMain(process.argv.slice(2));
}
