export interface PercentileResult {
  p50?: number | undefined;
  p95?: number | undefined;
  p99?: number | undefined;
  max?: number | undefined;
}

function pickPercentile(sorted: number[], p: number): number | undefined {
  if (sorted.length === 0) {
    return undefined;
  }
  if (sorted.length === 1) {
    return sorted[0];
  }
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) {
    return sorted[lo];
  }
  const loVal = sorted[lo] ?? 0;
  const hiVal = sorted[hi] ?? 0;
  return loVal + (hiVal - loVal) * (rank - lo);
}

export function computePercentiles(samples: number[]): PercentileResult {
  const finite = samples.filter((s) => Number.isFinite(s));
  if (finite.length === 0) {
    return { p50: undefined, p95: undefined, p99: undefined, max: undefined };
  }
  const sorted = [...finite].sort((a, b) => a - b);
  return {
    p50: pickPercentile(sorted, 50),
    p95: pickPercentile(sorted, 95),
    p99: pickPercentile(sorted, 99),
    max: sorted.at(-1),
  };
}
