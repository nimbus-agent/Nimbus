import { describe, expect, test } from "bun:test";

import { interpolatedPercentile } from "./interpolated-percentile.ts";

describe("interpolatedPercentile", () => {
  test("empty -> 0", () => {
    expect(interpolatedPercentile([], 0.5)).toBe(0);
  });
  test("single sample is every percentile", () => {
    expect(interpolatedPercentile([42], 0.95)).toBe(42);
  });
  test("exact rank returns the sample", () => {
    expect(interpolatedPercentile([1, 2, 3], 0.5)).toBe(2);
  });
  test("between ranks interpolates linearly", () => {
    expect(interpolatedPercentile([10, 20], 0.25)).toBe(12.5);
  });
  test("p outside [0,1] falls back to the max rather than undefined", () => {
    expect(interpolatedPercentile([1, 2, 3], 2)).toBe(3);
  });
});
