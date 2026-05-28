export type IntervalUnit = "sec" | "min" | "hr";

export interface IntervalParts {
  readonly value: number;
  readonly unit: IntervalUnit;
}

export function fromMs(ms: number): IntervalParts {
  if (ms <= 0) return { value: 1, unit: "min" };
  if (ms % 3_600_000 === 0) return { value: ms / 3_600_000, unit: "hr" };
  if (ms % 60_000 === 0) return { value: ms / 60_000, unit: "min" };
  return { value: Math.round(ms / 1000), unit: "sec" };
}

export function toMs(parts: IntervalParts): number {
  switch (parts.unit) {
    case "sec":
      return parts.value * 1000;
    case "min":
      return parts.value * 60_000;
    case "hr":
      return parts.value * 3_600_000;
  }
}

export const MIN_INTERVAL_MS = 60_000;
