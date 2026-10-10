/**
 * The percentile at `p` (a FRACTION in [0, 1], not 0..100) over an ALREADY-SORTED ascending array,
 * linearly interpolated between the two neighbouring ranks; `0` for an empty array.
 *
 * Shared by the query-latency ring (`db/latency-ring-buffer.ts`) and the agent-invocation latency
 * recorder (`telemetry/agent-latency.ts`), so both telemetry percentile pairs are computed the same
 * way. `perf/percentiles.ts`'s `pickPercentile` is a different contract (0..100, `undefined` when
 * empty) used by the benchmark harness and is deliberately not merged into this one.
 */
export function interpolatedPercentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const loV = sorted[lo];
  const hiV = sorted[hi];
  if (loV === undefined || hiV === undefined) {
    return sorted.at(-1) ?? 0;
  }
  if (lo === hi) {
    return loV;
  }
  return loV * (hi - idx) + hiV * (idx - lo);
}
