const WEIGHT_FTS = 0.5;
const WEIGHT_RECENCY = 0.3;
const WEIGHT_SERVICE = 0.2;

export function recencyScore(modifiedAtMs: number, nowMs: number): number {
  const days = Math.max(0, (nowMs - modifiedAtMs) / 86_400_000);
  return 1 / (1 + days);
}

export function servicePriorityScore(
  service: string,
  priorities: ReadonlyMap<string, number>,
): number {
  const v = priorities.get(service);
  if (typeof v === "number" && Number.isFinite(v)) {
    return Math.min(1, Math.max(0, v));
  }
  return 0.5;
}

function minMaxNormalize(
  values: readonly number[],
  transform: (v: number, min: number, max: number) => number,
): number[] {
  if (values.length === 0) {
    return [];
  }
  const head = values[0];
  if (head === undefined) {
    return [];
  }
  let min = head;
  let max = head;
  for (const v of values) {
    if (Number.isFinite(v)) {
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    return values.map(() => 1);
  }
  return values.map((v) => {
    if (!Number.isFinite(v)) {
      return 0.5;
    }
    return transform(v, min, max);
  });
}

export function normalizeBm25LowerIsBetter(values: readonly number[]): number[] {
  return minMaxNormalize(values, (v, min, max) => (max - v) / (max - min));
}

export function compositeSearchScore(normBm25: number, recency: number, serviceP: number): number {
  return WEIGHT_FTS * normBm25 + WEIGHT_RECENCY * recency + WEIGHT_SERVICE * serviceP;
}

export function normalizeHigherIsBetter(values: readonly number[]): number[] {
  return minMaxNormalize(values, (v, min, max) => (v - min) / (max - min));
}
