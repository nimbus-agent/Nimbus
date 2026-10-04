/**
 * `sampleRss` paths `rss-sampler.test.ts` does not reach: a signal that aborts while a sample is
 * being taken, the default interval, a sampler that reports a non-finite value, and the default
 * sampler itself (the real `pidusage` against this test process).
 */
import { describe, expect, test } from "bun:test";
import { sampleRss } from "./rss-sampler.ts";

/**
 * A clock that moves inside `sleep` — the paired-hook shape `rss-sampler.test.ts` uses — plus
 * `advance`, so a sample itself can take virtual time. `sleeps` records every wait asked for.
 */
function virtualClock(): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  advance: (ms: number) => void;
  sleeps: number[];
} {
  let t = 0;
  let readsSinceAdvance = 0;
  const sleeps: number[] = [];
  return {
    now: () => {
      readsSinceAdvance += 1;
      if (readsSinceAdvance > 10_000) {
        throw new Error(
          "virtual clock read 10000 times without advancing — the sampler is spinning",
        );
      }
      return t;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
      readsSinceAdvance = 0;
      await Promise.resolve();
    },
    advance: (ms) => {
      t += ms;
      readsSinceAdvance = 0;
    },
    sleeps,
  };
}

describe("sampleRss — abort while sampling", () => {
  test("a signal aborted during a sample ends the following wait at once, not after the interval", async () => {
    const ac = new AbortController();
    const t0 = performance.now();
    const result = await sampleRss({
      pid: 1,
      durationMs: 60_000,
      intervalMs: 20_000,
      pidusage: async () => {
        // The loop checked `aborted` before this call; the real sleep that follows must see it.
        ac.abort();
        return { memory: 42 };
      },
      signal: ac.signal,
    });
    expect(result).toEqual({ samples: [42], p95: 42, intervalsMissed: 0 });
    // Without the already-aborted check the sleep waits out the 20 s interval.
    expect(performance.now() - t0).toBeLessThan(10_000);
  });
});

describe("sampleRss — defaults and odd readings", () => {
  test("without intervalMs, samples are taken once a second", async () => {
    const clock = virtualClock();
    const at: number[] = [];
    const result = await sampleRss({
      pid: 1,
      durationMs: 2_500,
      pidusage: async () => {
        at.push(clock.now());
        return { memory: 10 };
      },
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(at).toEqual([0, 1_000, 2_000]);
    expect(result.samples).toEqual([10, 10, 10]);
  });

  test("a sample slower than the interval skips the wait and samples again at once", async () => {
    const clock = virtualClock();
    const at: number[] = [];
    const result = await sampleRss({
      pid: 1,
      durationMs: 30,
      intervalMs: 10,
      pidusage: async () => {
        at.push(clock.now());
        // Each read takes 25 ms of virtual time — past the next interval boundary.
        clock.advance(25);
        return { memory: 7 };
      },
      now: clock.now,
      sleep: clock.sleep,
    });
    // A boundary already behind the clock means no sleep at all: no catch-up burst, no sleep(0).
    expect(clock.sleeps).toEqual([]);
    expect(at).toEqual([0, 25]);
    expect(result.samples).toEqual([7, 7]);
  });

  test("a sampler reporting only non-finite values yields p95 0, never NaN", async () => {
    const clock = virtualClock();
    const result = await sampleRss({
      pid: 1,
      durationMs: 30,
      intervalMs: 10,
      pidusage: async () => ({ memory: Number.NaN }),
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(result.samples).toHaveLength(3);
    expect(result.samples.every((m) => Number.isNaN(m))).toBe(true);
    expect(result.p95).toBe(0);
    expect(result.intervalsMissed).toBe(0);
  });

  test("the default sampler reads this process's real memory", async () => {
    // Two calls: the first loads `pidusage`, the second reuses the cached module. A window this
    // short holds one interval boundary, so each call takes one read (two if the closing sleep
    // wakes a hair early). Every read must SUCCEED: pidusage reads /proc on Linux, `ps` on macOS
    // and WMI on Windows, all present on every CI host, and `sampleRss` turns a failed read into a
    // missed interval — so tolerating one here would let a broken default sampler (a failed
    // import, a sampler that always throws) pass as a host without a stats tool.
    for (let call = 0; call < 2; call += 1) {
      const result = await sampleRss({ pid: process.pid, durationMs: 50, intervalMs: 10_000 });
      expect(result.intervalsMissed).toBe(0);
      expect(result.samples.length).toBeGreaterThanOrEqual(1);
      for (const memory of result.samples) {
        // RSS / working set of a live Bun process: comfortably above a megabyte.
        expect(memory).toBeGreaterThan(1_000_000);
      }
      expect(result.p95).toBeGreaterThan(1_000_000);
    }
  });
});
