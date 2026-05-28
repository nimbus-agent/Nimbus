import { describe, expect, test } from "bun:test";
import { computePercentiles } from "./percentiles.ts";

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
});
