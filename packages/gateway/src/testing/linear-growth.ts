import { expect } from "bun:test";

/**
 * Shared measurement for the "costs linear, not quadratic, time" tests.
 *
 * Those tests time a batch of calls at four input sizes (three doublings) and assert that the
 * end-to-end ratio stays far below the quadratic ~64x. Each size used to be timed ONCE, so a single
 * batch that lost the CPU — a GC pause, or another `bun test --parallel` worker on a runner with no
 * spare core — inflated one sample and could push the ratio past the bound with nothing wrong in
 * the code. windows-2025 hit exactly that on the cue-mining test, failing in 83 ms total.
 *
 * Each size is now timed over several TRIALS and the fastest one is kept. Interference only ever
 * ADDS time, so the minimum is the closest estimate of the work itself; a quadratic regression is
 * slow on every trial, so it still fails.
 */

/** Trials per size. The best is kept, so one preempted trial cannot set the sample. */
const TRIALS = 5;

/**
 * Largest allowed ratio between the last and first size's best trial, over three doublings.
 *
 * Ideal linear growth is 8x and quadratic is 64x. 16 was the bound when each test carried its own
 * copy, and it is too close to linear on a contended runner: with best-of-trials, eight processes
 * sharing four cores still measured linear forms at 17.1–17.7x (a larger input stops fitting in a
 * cache that other processes are also using). 32 keeps a 2x margin from quadratic on both sides.
 */
export const LINEAR_GROWTH_MAX_END_TO_END = 32;

/**
 * Floor for the smallest size's sample, so a fast machine measuring near the clock's resolution
 * cannot manufacture a huge ratio out of noise.
 */
const BASELINE_FLOOR_MS = 0.5;

export interface GrowthCase {
  /** Input sizes, smallest first. Four sizes = three doublings: linear ~8x, quadratic ~64x. */
  readonly sizes: readonly number[];
  /** Calls per trial, so a linear trial lasts milliseconds rather than clock noise. */
  readonly repeats: number;
  /**
   * Upper bound on the best trial at any size. A quadratic form blows it within the first sizes, so
   * a regression fails fast instead of hanging the suite.
   */
  readonly perSizeCeilingMs: number;
  /**
   * Builds the input for size `n` and returns the call to time. It runs once untimed to warm the
   * JIT, which is also where a caller can assert the call's result.
   */
  readonly makeCall: (n: number) => () => void;
}

/** Best-of-{@link TRIALS} batch time, in ms, for each size in order. */
export function bestTimingsAcrossSizes(c: GrowthCase): number[] {
  const timings: number[] = [];
  for (const n of c.sizes) {
    const call = c.makeCall(n);
    call();
    let best = Number.POSITIVE_INFINITY;
    for (let t = 0; t < TRIALS; t += 1) {
      const startedAt = performance.now();
      for (let i = 0; i < c.repeats; i += 1) call();
      best = Math.min(best, performance.now() - startedAt);
      // Every trial runs on the healthy path: a preempted FIRST trial is the very sample this
      // exists to discard, so stopping on a "fast enough" one would keep it. The only early exit is
      // a regression — two trials both over the ceiling — so a quadratic form still fails fast.
      if (t >= 1 && best >= c.perSizeCeilingMs) break;
    }
    expect(best).toBeLessThan(c.perSizeCeilingMs);
    timings.push(best);
  }
  return timings;
}

/** Asserts the curve described by `c` is linear, and returns the per-size timings for inspection. */
export function expectLinearGrowth(c: GrowthCase): number[] {
  const timings = bestTimingsAcrossSizes(c);
  const first = timings[0] ?? 0;
  const last = timings.at(-1) ?? 0;
  expect(last / Math.max(first, BASELINE_FLOOR_MS)).toBeLessThan(LINEAR_GROWTH_MAX_END_TO_END);
  return timings;
}
