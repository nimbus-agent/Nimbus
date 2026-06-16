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

/**
 * Pool per-run samples for the latency aggregate, dropping the single worst run.
 * One catastrophically-contended run (disk thrash / network hang spiking *all*
 * its samples) would otherwise skew the pooled p95, so with >=3 non-empty runs we
 * rank runs by their own p95 and discard the highest before flattening. With
 * fewer than 3 non-empty runs there is too little to trim, so we pool everything.
 */
export function poolTrimmedSamples(perRunSamples: number[][]): number[] {
  const runs = perRunSamples.filter((r) => r.length > 0);
  if (runs.length < 3) {
    return runs.flat();
  }
  const ranked = [...runs].sort((a, b) => {
    const pa = computePercentiles(a).p95 ?? Number.POSITIVE_INFINITY;
    const pb = computePercentiles(b).p95 ?? Number.POSITIVE_INFINITY;
    return pa - pb;
  });
  return ranked.slice(0, -1).flat();
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
  const pooled = poolTrimmedSamples(perRunSamples);
  const p = computePercentiles(pooled);
  return {
    surfaceId,
    samplesCount: totalSamples,
    ...(p.p50 !== undefined && { p50Ms: p.p50 }),
    ...(p.p95 !== undefined && { p95Ms: p.p95 }),
    ...(p.p99 !== undefined && { p99Ms: p.p99 }),
    ...(p.max !== undefined && { maxMs: p.max }),
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
