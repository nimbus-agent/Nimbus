import { describe, expect, test } from "bun:test";
import { sampleRss } from "./rss-sampler.ts";

function fakePidusage(seq: (number | "throw")[]): (pid: number) => Promise<{ memory: number }> {
  let i = 0;
  return async () => {
    const v = seq[i++ % seq.length];
    if (v === "throw") throw new Error("process gone");
    return { memory: v as number };
  };
}

/**
 * A virtual clock plus the sleep that drives it.
 *
 * The sample count is a function of how many interval boundaries fit inside
 * `durationMs`. Measured against a REAL clock that made it an assertion about
 * the scheduler's punctuality: a loaded CI runner overshoots each `setTimeout`,
 * the overshoot accumulates against the deadline, and a run that should produce
 * 5 samples produced 3 — which is how `>= 4` flaked on a release PR.
 *
 * Injecting both halves (never one — a virtual clock racing a real timer is its
 * own hang) makes the count exact, so the tolerance band below becomes a single
 * number and the test gets STRICTER rather than more forgiving.
 */
function virtualClock(): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
} {
  let t = 0;
  let readsSinceAdvance = 0;
  return {
    now: () => {
      // SPIN GUARD. The sampler skips its sleep when the computed wait is <= 0
      // (`if (wait <= 0) continue`). Against a real clock that is harmless —
      // time passes anyway and the deadline arrives. Against a clock that only
      // advances inside `sleep`, it is an infinite loop that HANGS the runner
      // instead of failing it, which is strictly worse than the flake this is
      // meant to fix. Found by sabotaging the loop bound to `<=` and watching
      // the suite run for ten minutes.
      readsSinceAdvance += 1;
      if (readsSinceAdvance > 10_000) {
        throw new Error(
          "virtual clock read 10000 times without advancing — sampleRss is spinning without sleeping",
        );
      }
      return t;
    },
    sleep: async (ms: number) => {
      t += ms;
      readsSinceAdvance = 0;
      // Yield once so the sampler's `await` actually suspends, matching the
      // real timer's turn-boundary behaviour.
      await Promise.resolve();
    },
  };
}

describe("sampleRss", () => {
  test("collects one sample per interval boundary in the window; computes p95", async () => {
    const clock = virtualClock();
    const result = await sampleRss({
      pid: 1,
      durationMs: 100,
      intervalMs: 20,
      pidusage: fakePidusage([100, 200, 300, 400, 500]),
      now: clock.now,
      sleep: clock.sleep,
    });
    // Exactly 5: boundaries at 0/20/40/60/80 are inside the window; at 100 the
    // deadline check ends the loop. No tolerance band, because there is no
    // longer anything to tolerate.
    expect(result.samples).toEqual([100, 200, 300, 400, 500]);
    expect(result.p95).toBeGreaterThanOrEqual(400);
    expect(result.intervalsMissed).toBe(0);
  });

  test("uses the real clock when none is injected", async () => {
    // Guards the default path: injecting a clock must not be the only way the
    // sampler works, or the tests above would prove nothing about production.
    // Deliberately asserts only what a real clock can guarantee — that the
    // window closes and at least one sample lands — never a count.
    const result = await sampleRss({
      pid: 1,
      durationMs: 30,
      intervalMs: 10,
      pidusage: fakePidusage([100, 200, 300]),
    });
    expect(result.samples.length).toBeGreaterThanOrEqual(1);
    expect(result.intervalsMissed).toBe(0);
  });

  test("intervalsMissed increments when pidusage throws", async () => {
    const result = await sampleRss({
      pid: 1,
      durationMs: 100,
      intervalMs: 20,
      pidusage: fakePidusage([100, "throw", 200, "throw", 300]),
    });
    expect(result.intervalsMissed).toBeGreaterThan(0);
    expect(result.samples.length).toBeGreaterThanOrEqual(2);
  });

  test("respects abort signal", async () => {
    const ac = new AbortController();
    const promise = sampleRss({
      pid: 1,
      durationMs: 10_000,
      intervalMs: 20,
      pidusage: fakePidusage([100]),
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 60);
    const result = await promise;
    expect(result.samples.length).toBeGreaterThanOrEqual(1);
    expect(result.samples.length).toBeLessThan(20);
  });

  test("empty sample set returns p95 = 0 (no division by zero)", async () => {
    const result = await sampleRss({
      pid: 1,
      durationMs: 50,
      intervalMs: 20,
      pidusage: fakePidusage(["throw"]),
    });
    expect(result.samples).toEqual([]);
    expect(result.p95).toBe(0);
    expect(result.intervalsMissed).toBeGreaterThan(0);
  });
});
