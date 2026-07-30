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

  test("rejects one-sided timing-hook injection instead of hanging", async () => {
    // The failure this prevents is a HANG, not a wrong answer: a frozen custom
    // `now` with the default real `setTimeout` means the loop reads a clock that
    // never moves while real time passes, so the deadline never arrives. Prose
    // in the type docs cannot stop that; this throw can.
    await expect(
      sampleRss({
        pid: 1,
        durationMs: 100,
        intervalMs: 20,
        pidusage: fakePidusage([100]),
        now: () => 0,
      }),
    ).rejects.toThrow(/must be provided together/);

    await expect(
      sampleRss({
        pid: 1,
        durationMs: 100,
        intervalMs: 20,
        pidusage: fakePidusage([100]),
        sleep: async () => {},
      }),
    ).rejects.toThrow(/must be provided together/);
  });

  test("neither hook, or both, is accepted", async () => {
    const clock = virtualClock();
    await expect(
      sampleRss({ pid: 1, durationMs: 20, intervalMs: 10, pidusage: fakePidusage([1]) }),
    ).resolves.toBeDefined();
    await expect(
      sampleRss({
        pid: 1,
        durationMs: 20,
        intervalMs: 10,
        pidusage: fakePidusage([1]),
        now: clock.now,
        sleep: clock.sleep,
      }),
    ).resolves.toBeDefined();
  });

  test("the real sleep does not accumulate abort listeners", async () => {
    // `{ once: true }` only detaches after the event FIRES, so every sleep that
    // ends normally used to leave its listener attached. A default 1000ms
    // interval over a 60s bench would stack 60 of them on one signal.
    const ac = new AbortController();
    let peak = 0;
    const realAdd = ac.signal.addEventListener.bind(ac.signal);
    let live = 0;
    ac.signal.addEventListener = ((type: string, fn: EventListener, opts?: unknown) => {
      if (type === "abort") {
        live += 1;
        peak = Math.max(peak, live);
      }
      realAdd(type, fn, opts as AddEventListenerOptions);
    }) as typeof ac.signal.addEventListener;
    const realRemove = ac.signal.removeEventListener.bind(ac.signal);
    ac.signal.removeEventListener = ((type: string, fn: EventListener, opts?: unknown) => {
      if (type === "abort") live -= 1;
      realRemove(type, fn, opts as EventListenerOptions);
    }) as typeof ac.signal.removeEventListener;

    // Many short real sleeps; none aborts, so every listener must be detached
    // by the normal path.
    await sampleRss({
      pid: 1,
      durationMs: 60,
      intervalMs: 5,
      pidusage: fakePidusage([1, 2, 3]),
      signal: ac.signal,
    });

    expect(peak).toBeGreaterThan(0); // the listener path really was exercised
    expect(live, "abort listeners were left attached after normal completion").toBe(0);
  });

  test("an already-aborted signal returns without waiting out the timeout", async () => {
    const ac = new AbortController();
    ac.abort();
    const t0 = performance.now();
    const result = await sampleRss({
      pid: 1,
      durationMs: 5_000,
      intervalMs: 1_000,
      pidusage: fakePidusage([1]),
      signal: ac.signal,
    });
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(result.samples.length).toBeLessThanOrEqual(1);
  });

  test("intervalsMissed increments when pidusage throws", async () => {
    // Clock-injected for the reason `virtualClock` above exists. What this test cares about is
    // the throw/sample bookkeeping, not the scheduler's punctuality — but `samples.length >= 2`
    // needed 3 of the 5 boundaries to land inside the window, so a loaded runner that overshot
    // into the deadline collected 1 sample and failed it. That is the flake that blocked the
    // v1.11.0 release gate; it is the same overshoot the comment above records, on the one count
    // assertion left against the real clock.
    const clock = virtualClock();
    const result = await sampleRss({
      pid: 1,
      durationMs: 100,
      intervalMs: 20,
      pidusage: fakePidusage([100, "throw", 200, "throw", 300]),
      now: clock.now,
      sleep: clock.sleep,
    });
    // Exact, not a floor: boundaries at 0/20/40/60/80, and the sequence throws on the 2nd and
    // 4th. Pinning all three numbers makes the test stricter than the band it replaces — it now
    // also catches a miscount that a `>= 2` floor would have accepted.
    expect(result.intervalsMissed).toBe(2);
    expect(result.samples).toEqual([100, 200, 300]);
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
