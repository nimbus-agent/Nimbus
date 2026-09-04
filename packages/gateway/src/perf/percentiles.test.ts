import { describe, expect, test } from "bun:test";
import { computePercentiles, pickPercentile } from "./percentiles.ts";

describe("computePercentiles", () => {
  test("returns undefined fields for empty input", () => {
    const r = computePercentiles([]);
    expect(r.p50).toBeUndefined();
    expect(r.p95).toBeUndefined();
    expect(r.p99).toBeUndefined();
    expect(r.max).toBeUndefined();
  });

  test("computes correct percentiles for a 100-sample uniform distribution", () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    const r = computePercentiles(samples);
    expect(r.p50).toBe(50.5);
    expect(r.p95).toBe(95.05);
    expect(r.p99).toBe(99.01);
    expect(r.max).toBe(100);
  });

  test("ignores NaN and non-finite samples", () => {
    const samples = [1, 2, Number.NaN, 3, Number.POSITIVE_INFINITY, 4];
    const r = computePercentiles(samples);
    expect(r.p50).toBe(2.5);
    expect(r.max).toBe(4);
  });

  test("handles a single sample", () => {
    const r = computePercentiles([42]);
    expect(r.p50).toBe(42);
    expect(r.p95).toBe(42);
    expect(r.p99).toBe(42);
    expect(r.max).toBe(42);
  });

  // A rank that lands EXACTLY on an index takes the no-interpolation arm, which every
  // even-length case above misses: with 100 samples the p50 rank is 49.5 and with 3 it is 1.0.
  test("takes an exact rank without interpolating", () => {
    expect(computePercentiles([1, 2, 3]).p50).toBe(2);
    expect(computePercentiles([1, 2, 3, 4, 5]).p50).toBe(3);
  });

  test("a two-sample set interpolates rather than picking a neighbour", () => {
    const r = computePercentiles([10, 20]);
    expect(r.p50).toBe(15);
    expect(r.max).toBe(20);
  });
});

/**
 * `pickPercentile` direct — the guards `computePercentiles` can never reach, because it filters
 * to finite samples and sorts before calling. They are still real behaviour on a direct call, and
 * covering them here is what lets this module carry no coverage exemption.
 */
describe("pickPercentile — the unreachable-from-computePercentiles guards", () => {
  test("an empty array yields undefined rather than NaN", () => {
    expect(pickPercentile([], 50)).toBeUndefined();
  });

  // The `?? 0` fallbacks need an index that is BOTH out of range and on the interpolating arm —
  // an integer rank takes the `lo === hi` short-circuit and returns `undefined` instead, which is
  // what the two cases below would have done had they been written at p=200 / p=-100.
  test("an above-range percentile interpolates toward the 0 fallback, never NaN", () => {
    // rank = 1.5 on a 2-element array: hi = 2, past the end, so hiVal falls back to 0.
    expect(pickPercentile([10, 20], 150)).toBe(10);
  });

  test("a below-range percentile interpolates from the 0 fallback, never NaN", () => {
    // rank = -0.5: lo = -1, before the start, so loVal falls back to 0.
    expect(pickPercentile([10, 20], -50)).toBe(5);
  });

  test("an exactly out-of-range integer rank yields undefined, not a fallback", () => {
    // rank = 2.0 takes the `lo === hi` arm and indexes past the end. Pinned because it is the
    // case the two above are deliberately NOT: same guard, different arm, different answer.
    expect(pickPercentile([10, 20], 200)).toBeUndefined();
  });

  test("a single-element array short-circuits before any rank arithmetic", () => {
    expect(pickPercentile([7], 99)).toBe(7);
  });
});
