import { expect, test } from "bun:test";

import { bestTimingsAcrossSizes, expectLinearGrowth } from "./linear-growth.ts";

/** Busy-waits `ms` — a stand-in for a trial that lost the CPU to another worker. */
function stall(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    /* spin */
  }
}

/** Work proportional to `n`, kept from being optimised away. */
function linearWork(n: number): number {
  let acc = 0;
  for (let i = 0; i < n; i += 1) acc = (acc + i) % 1_000_003;
  return acc;
}

const SIZES = [2_000, 4_000, 8_000, 16_000] as const;

test("one stalled trial at the largest size does not fail a linear curve", () => {
  // The flake this helper exists for: a single-sample version keeps the 40 ms stall as the last
  // size's timing, against a baseline of well under a millisecond — a ratio far past 16.
  let stalls = 0;
  const timings = expectLinearGrowth({
    sizes: SIZES,
    repeats: 20,
    perSizeCeilingMs: 1000,
    prepare: (n) => {
      let calls = 0;
      return () => {
        calls += 1;
        // Call 1 is the untimed warm-up; call 2 is the first call of the first timed trial.
        if (n === SIZES[SIZES.length - 1] && calls === 2) {
          stalls += 1;
          stall(40);
        }
        linearWork(n);
      };
    },
  });
  expect(stalls).toBe(1);
  expect(timings[timings.length - 1]).toBeLessThan(40);
});

test("a quadratic curve still fails", () => {
  expect(() =>
    expectLinearGrowth({
      sizes: SIZES,
      repeats: 1,
      perSizeCeilingMs: 10_000,
      // Sized so the SMALLEST size is ~1 ms, twice the 0.5 ms baseline floor, leaving the largest
      // ~64x past it. Smaller and the floor flattens the curve, so this would pass for the wrong
      // reason (observed at n * n / 400: 0.05 ms -> 3.1 ms, a "ratio" of 6).
      prepare: (n) => () => {
        linearWork((n * n) / 20);
      },
    }),
  ).toThrow();
});

test("a size whose best trial still exceeds the ceiling fails without running every trial", () => {
  let calls = 0;
  expect(() =>
    bestTimingsAcrossSizes({
      sizes: [1],
      repeats: 1,
      perSizeCeilingMs: 5,
      prepare: () => () => {
        calls += 1;
        stall(10);
      },
    }),
  ).toThrow();
  // One warm-up call, then two over-ceiling trials end the size early.
  expect(calls).toBe(3);
});
