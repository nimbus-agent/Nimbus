import { computePercentiles } from "./percentiles.ts";
import type {
  BenchResultKind,
  BenchRunOptions,
  BenchSurfaceId,
  BenchSurfaceResult,
} from "./types.ts";

export type SurfaceFn = (opts: BenchRunOptions) => Promise<number[]>;

function median(values: number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

export interface RunBenchDeps {
  stderr?: (s: string) => void;
}

async function runSurfaceOnce(
  surfaceId: BenchSurfaceId,
  fn: SurfaceFn,
  opts: BenchRunOptions,
  runIndex: number,
  stderr: (s: string) => void,
): Promise<number[]> {
  try {
    return await fn(opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const suffix = err instanceof Error && err.stack ? `\n${err.stack}` : "";
    stderr(`[bench:${surfaceId}] run ${runIndex + 1}/${opts.runs} failed: ${msg}${suffix}`);
    throw new Error(
      `bench surface ${surfaceId} failed on run ${runIndex + 1}/${opts.runs}: ${msg}`,
    );
  }
}

function buildThroughputResult(
  surfaceId: BenchSurfaceId,
  perRunSamples: number[][],
  totalSamples: number,
): BenchSurfaceResult {
  const perRunMedians: number[] = [];
  for (const s of perRunSamples) {
    const m = median(s);
    if (m !== undefined) perRunMedians.push(m);
  }
  const throughputPerSec = median(perRunMedians);
  return {
    surfaceId,
    samplesCount: totalSamples,
    ...(throughputPerSec !== undefined && { throughputPerSec }),
  };
}

function buildRssResult(
  surfaceId: BenchSurfaceId,
  perRunSamples: number[][],
  totalSamples: number,
): BenchSurfaceResult {
  const allSamples: number[] = perRunSamples.flat();
  const p = computePercentiles(allSamples);
  return {
    surfaceId,
    samplesCount: totalSamples,
    ...(p.p95 !== undefined && { rssBytesP95: p.p95 }),
    rawSamples: allSamples,
  };
}

function buildLatencyResult(
  surfaceId: BenchSurfaceId,
  perRunSamples: number[][],
  totalSamples: number,
): BenchSurfaceResult {
  const perRunP50: number[] = [];
  const perRunP95: number[] = [];
  const perRunP99: number[] = [];
  const perRunMax: number[] = [];
  for (const samples of perRunSamples) {
    const p = computePercentiles(samples);
    if (p.p50 !== undefined) perRunP50.push(p.p50);
    if (p.p95 !== undefined) perRunP95.push(p.p95);
    if (p.p99 !== undefined) perRunP99.push(p.p99);
    if (p.max !== undefined) perRunMax.push(p.max);
  }
  const p50Ms = median(perRunP50);
  const p95Ms = median(perRunP95);
  const p99Ms = median(perRunP99);
  const maxMs = median(perRunMax);
  return {
    surfaceId,
    samplesCount: totalSamples,
    ...(p50Ms !== undefined && { p50Ms }),
    ...(p95Ms !== undefined && { p95Ms }),
    ...(p99Ms !== undefined && { p99Ms }),
    ...(maxMs !== undefined && { maxMs }),
  };
}

export async function runBench(
  surfaceId: BenchSurfaceId,
  fn: SurfaceFn,
  opts: BenchRunOptions,
  deps: RunBenchDeps = {},
  resultKind: BenchResultKind = "latency",
): Promise<BenchSurfaceResult> {
  if (opts.runs < 1) {
    throw new Error(`runs must be >= 1 (got ${opts.runs})`);
  }
  const stderr = deps.stderr ?? ((s: string) => process.stderr.write(`${s}\n`));
  const perRunSamples: number[][] = [];
  let totalSamples = 0;

  for (let i = 0; i < opts.runs; i += 1) {
    const samples = await runSurfaceOnce(surfaceId, fn, opts, i, stderr);
    perRunSamples.push(samples);
    totalSamples += samples.length;
  }

  if (resultKind === "throughput") {
    return buildThroughputResult(surfaceId, perRunSamples, totalSamples);
  }
  if (resultKind === "rss") {
    return buildRssResult(surfaceId, perRunSamples, totalSamples);
  }
  return buildLatencyResult(surfaceId, perRunSamples, totalSamples);
}
