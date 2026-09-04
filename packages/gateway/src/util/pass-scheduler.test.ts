import { describe, expect, test } from "bun:test";

import { createPassScheduler, type PassRefusal } from "./pass-scheduler.ts";

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class TestRefusal extends Error {
  readonly kind: PassRefusal;
  constructor(kind: PassRefusal) {
    super(`refused: ${kind}`);
    this.kind = kind;
  }
}

/**
 * The scheduler under a deliberately minimal set of dependencies.
 *
 * `runPass` records every `(signal, opts)` it was handed, so the tests below can assert on what
 * the scheduler PASSED rather than only on how many times it ran — the scheduled path and the
 * on-demand path differ precisely in the options they supply, and a scheduler that passed the
 * caller's options on the debounced path would be indistinguishable by call count alone.
 */
function makeScheduler(over?: {
  isEnabled?: () => boolean;
  debounceMs?: number;
  body?: (signal: AbortSignal, opts: string) => Promise<string>;
  onError?: (err: unknown) => void;
}) {
  const seen: Array<{ opts: string; aborted: boolean }> = [];
  const scheduler = createPassScheduler<string, string>({
    ...(over?.isEnabled === undefined ? {} : { isEnabled: over.isEnabled }),
    debounceMs: over?.debounceMs ?? 5,
    runPass: async (signal, opts) => {
      seen.push({ opts, aborted: signal.aborted });
      return over?.body === undefined ? `ran:${opts}` : await over.body(signal, opts);
    },
    scheduledOptions: "scheduled",
    ...(over?.onError === undefined ? {} : { onError: over.onError }),
    refuse: (kind) => new TestRefusal(kind),
  });
  return { scheduler, seen };
}

describe("createPassScheduler — debounce and coalescing", () => {
  test("a burst of triggers coalesces into ONE pass", async () => {
    const { scheduler, seen } = makeScheduler({ debounceMs: 20 });
    scheduler.trigger();
    scheduler.trigger();
    scheduler.trigger();
    await tick(60);
    expect(seen).toHaveLength(1);
    scheduler.stop();
  });

  test("the debounced path passes `scheduledOptions`, never the caller's", async () => {
    const { scheduler, seen } = makeScheduler();
    scheduler.trigger();
    await tick(40);
    expect(seen.map((s) => s.opts)).toEqual(["scheduled"]);
    scheduler.stop();
  });

  test("a trigger during a running pass schedules EXACTLY ONE follow-up", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let first = true;
    const { scheduler, seen } = makeScheduler({
      debounceMs: 5,
      body: async (_s, opts) => {
        if (first) {
          first = false;
          await gate;
        }
        return `ran:${opts}`;
      },
    });
    scheduler.trigger();
    await tick(30);
    expect(seen).toHaveLength(1); // in flight, blocked on `gate`

    // Three more syncs land mid-pass. Exactly one follow-up must result — not three.
    scheduler.trigger();
    scheduler.trigger();
    scheduler.trigger();
    await tick(30);
    expect(seen).toHaveLength(1);

    release();
    await tick(40);
    expect(seen).toHaveLength(2);
    scheduler.stop();
  });

  test("an error from a scheduled pass reaches onError and does not wedge `running`", async () => {
    const errors: unknown[] = [];
    const { scheduler, seen } = makeScheduler({
      debounceMs: 5,
      body: async () => {
        throw new Error("pass exploded");
      },
      onError: (e) => errors.push(e),
    });
    scheduler.trigger();
    await tick(30);
    expect(errors).toHaveLength(1);
    // Not wedged: a second trigger still runs.
    scheduler.trigger();
    await tick(30);
    expect(seen).toHaveLength(2);
    scheduler.stop();
  });

  test("a scheduled pass that throws with NO onError is swallowed, not unhandled", async () => {
    const { scheduler, seen } = makeScheduler({
      debounceMs: 5,
      body: async () => {
        throw new Error("pass exploded");
      },
    });
    scheduler.trigger();
    await tick(30);
    expect(seen).toHaveLength(1);
    scheduler.stop();
  });
});

describe("createPassScheduler — runNow", () => {
  test("passes the CALLER's options through, unlike the debounced path", async () => {
    const { scheduler, seen } = makeScheduler();
    await expect(scheduler.runNow("on-demand")).resolves.toBe("ran:on-demand");
    expect(seen.map((s) => s.opts)).toEqual(["on-demand"]);
    scheduler.stop();
  });

  test("refuses `running` while a scheduled pass is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { scheduler } = makeScheduler({
      debounceMs: 5,
      body: async (_s, opts) => {
        await gate;
        return `ran:${opts}`;
      },
    });
    scheduler.trigger();
    await tick(25);
    await expect(scheduler.runNow("x")).rejects.toMatchObject({ kind: "running" });
    release();
    await tick(20);
    scheduler.stop();
  });

  test("a trigger landing during runNow still gets its follow-up", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let first = true;
    const { scheduler, seen } = makeScheduler({
      debounceMs: 5,
      body: async (_s, opts) => {
        if (first) {
          first = false;
          await gate;
        }
        return `ran:${opts}`;
      },
    });
    const inFlight = scheduler.runNow("on-demand");
    await tick(10);
    scheduler.trigger();
    release();
    await inFlight;
    await tick(30);
    // The follow-up runs on the SCHEDULED options — it stands in for the sync that landed, not
    // for the on-demand caller.
    expect(seen.map((s) => s.opts)).toEqual(["on-demand", "scheduled"]);
    scheduler.stop();
  });

  test("a rejected runNow releases the single-flight guard ON THE SAME scheduler", async () => {
    // The second call must go through THIS scheduler, not a fresh one: a fresh scheduler has its
    // own `running` state, so it would resolve happily while the first stayed wedged and refused
    // every later call as "running". That version of this test could not fail for the reason it
    // exists — which is the whole property under test.
    let first = true;
    const { scheduler, seen } = makeScheduler({
      body: async (_s, opts) => {
        if (first) {
          first = false;
          throw new Error("boom");
        }
        return `ran:${opts}`;
      },
    });
    await expect(scheduler.runNow("a")).rejects.toThrow("boom");
    expect(scheduler.status()).toBe("idle");
    await expect(scheduler.runNow("b")).resolves.toBe("ran:b");
    expect(seen.map((s) => s.opts)).toEqual(["a", "b"]);
    scheduler.stop();
  });

  test("a scheduled pass that throws also releases the guard for a later runNow", async () => {
    // The same property on the OTHER entry point: `fire`'s `.catch(...).finally(...)` is a
    // different release site from `runNow`'s `try/finally`, and one can wedge while the other
    // does not.
    let first = true;
    const { scheduler } = makeScheduler({
      debounceMs: 5,
      body: async (_s, opts) => {
        if (first) {
          first = false;
          throw new Error("scheduled boom");
        }
        return `ran:${opts}`;
      },
      onError: () => undefined,
    });
    scheduler.trigger();
    await tick(30);
    expect(scheduler.status()).toBe("idle");
    await expect(scheduler.runNow("after")).resolves.toBe("ran:after");
    scheduler.stop();
  });

  test("refusal ORDER is disabled, then stopped, then running", async () => {
    // A scheduler that is BOTH disabled and stopped reports `disabled`: it is the one the user
    // can act on, and reporting "shutting down" for a config problem sends them to the wrong fix.
    const { scheduler } = makeScheduler({ isEnabled: () => false });
    scheduler.stop();
    await expect(scheduler.runNow("x")).rejects.toMatchObject({ kind: "disabled" });
  });
});

describe("createPassScheduler — enabled and status", () => {
  test("omitting isEnabled means always enabled", async () => {
    const { scheduler } = makeScheduler();
    expect(scheduler.status()).toBe("idle");
    await expect(scheduler.runNow("x")).resolves.toBe("ran:x");
    scheduler.stop();
  });

  test("a disabled scheduler ignores triggers and refuses runNow", async () => {
    const { scheduler, seen } = makeScheduler({ isEnabled: () => false });
    scheduler.trigger();
    await tick(30);
    expect(seen).toHaveLength(0);
    expect(scheduler.status()).toBe("disabled");
    await expect(scheduler.runNow("x")).rejects.toMatchObject({ kind: "disabled" });
    scheduler.stop();
  });

  test("isEnabled is re-read, not captured once", async () => {
    let on = false;
    const { scheduler, seen } = makeScheduler({ debounceMs: 5, isEnabled: () => on });
    scheduler.trigger();
    await tick(25);
    expect(seen).toHaveLength(0);
    on = true;
    scheduler.trigger();
    await tick(25);
    expect(seen).toHaveLength(1);
    scheduler.stop();
  });

  test("status reports running while a pass is in flight, and idle after", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { scheduler } = makeScheduler({
      body: async (_s, opts) => {
        await gate;
        return `ran:${opts}`;
      },
    });
    const inFlight = scheduler.runNow("x");
    expect(scheduler.status()).toBe("running");
    release();
    await inFlight;
    expect(scheduler.status()).toBe("idle");
    scheduler.stop();
  });

  test("status reports stopped ahead of disabled", () => {
    const { scheduler } = makeScheduler({ isEnabled: () => false });
    expect(scheduler.status()).toBe("disabled");
    scheduler.stop();
    expect(scheduler.status()).toBe("stopped");
  });
});

describe("createPassScheduler — stop", () => {
  test("stop cancels a pending debounced pass", async () => {
    const { scheduler, seen } = makeScheduler({ debounceMs: 30 });
    scheduler.trigger();
    scheduler.stop();
    await tick(60);
    expect(seen).toHaveLength(0);
  });

  test("stop refuses every later trigger and runNow", async () => {
    const { scheduler, seen } = makeScheduler();
    scheduler.stop();
    scheduler.trigger();
    await tick(30);
    expect(seen).toHaveLength(0);
    await expect(scheduler.runNow("x")).rejects.toMatchObject({ kind: "stopped" });
  });

  test("stop aborts the shared signal a pass is handed", async () => {
    let observed: AbortSignal | undefined;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { scheduler } = makeScheduler({
      body: async (signal, opts) => {
        observed = signal;
        await gate;
        return `ran:${opts}`;
      },
    });
    const inFlight = scheduler.runNow("x");
    await tick(5);
    expect(observed?.aborted).toBe(false);
    scheduler.stop();
    expect(observed?.aborted).toBe(true);
    release();
    await inFlight;
  });

  test("a stop landing DURING a pass suppresses the dirty follow-up", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let first = true;
    const { scheduler, seen } = makeScheduler({
      debounceMs: 5,
      body: async (_s, opts) => {
        if (first) {
          first = false;
          await gate;
        }
        return `ran:${opts}`;
      },
    });
    scheduler.trigger();
    await tick(25);
    scheduler.trigger(); // marks dirty via `fire`
    await tick(15);
    scheduler.stop();
    release();
    await tick(40);
    // The follow-up re-enters through `fire`, whose single `stopped` check is what suppresses it.
    expect(seen).toHaveLength(1);
  });

  test("stop is idempotent", async () => {
    const { scheduler, seen } = makeScheduler();
    scheduler.stop();
    scheduler.stop();
    scheduler.trigger();
    await tick(30);
    expect(seen).toHaveLength(0);
    expect(scheduler.status()).toBe("stopped");
  });
});
