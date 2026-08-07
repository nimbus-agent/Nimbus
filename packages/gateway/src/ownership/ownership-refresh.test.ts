import { describe, expect, test } from "bun:test";

import type { OwnershipPassSummary } from "./ownership-pass.ts";
import { createOwnershipRefresher, OwnershipRefresherError } from "./ownership-refresh.ts";

const SUMMARY: OwnershipPassSummary = {
  rootsTotal: 0,
  rootsCovered: 0,
  rootsWithRemote: 0,
  filesCovered: 0,
  filesExcluded: 0,
  servicesBound: 0,
  ownersEmitted: 0,
  entitiesReaped: 0,
  durationMs: 0,
};

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A promise plus its externally-callable resolver, for deterministic control of an in-flight `runPass()`. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("createOwnershipRefresher", () => {
  test("coalesces a burst of triggers into one pass", async () => {
    let calls = 0;
    const r = createOwnershipRefresher({
      debounceMs: 20,
      runPass: async () => {
        calls += 1;
        return SUMMARY;
      },
    });
    r.trigger();
    r.trigger();
    r.trigger();
    await tick(60);
    expect(calls).toBe(1);
    r.stop();
  });

  test("a trigger during a running pass schedules exactly one follow-up", async () => {
    let calls = 0;
    const r = createOwnershipRefresher({
      debounceMs: 5,
      runPass: async () => {
        calls += 1;
        await tick(30);
        return SUMMARY;
      },
    });
    r.trigger();
    await tick(15);
    r.trigger();
    r.trigger();
    await tick(120);
    expect(calls).toBe(2);
    r.stop();
  });

  test("run() bypasses the debounce and returns the summary", async () => {
    const r = createOwnershipRefresher({ debounceMs: 10_000, runPass: async () => SUMMARY });
    expect(await r.run()).toEqual(SUMMARY);
    r.stop();
  });

  test("a throwing pass reaches onError and does not wedge the refresher", async () => {
    let errs = 0;
    let calls = 0;
    const r = createOwnershipRefresher({
      debounceMs: 5,
      runPass: async () => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        return SUMMARY;
      },
      onError: () => {
        errs += 1;
      },
    });
    r.trigger();
    await tick(40);
    r.trigger();
    await tick(40);
    expect(errs).toBe(1);
    expect(calls).toBe(2);
    r.stop();
  });

  test("stop() prevents a pending debounced pass from firing", async () => {
    let calls = 0;
    const r = createOwnershipRefresher({
      debounceMs: 30,
      runPass: async () => {
        calls += 1;
        return SUMMARY;
      },
    });
    r.trigger();
    r.stop();
    await tick(80);
    expect(calls).toBe(0);
  });

  test("run() rejects after stop() and starts no pass", async () => {
    // `stop()` runs as a gateway shutdown callback; an on-demand pass must not
    // start writing graph rows while the sidecars are closing.
    let calls = 0;
    const r = createOwnershipRefresher({
      debounceMs: 30,
      runPass: async () => {
        calls += 1;
        return SUMMARY;
      },
    });
    r.stop();
    await expect(r.run()).rejects.toThrow("ERR_OWNERSHIP_STOPPED");
    expect(calls).toBe(0);
  });

  test("run() rejects with ERR_OWNERSHIP_PASS_RUNNING while a pass is already running", async () => {
    const gate = deferred();
    let calls = 0;
    const r = createOwnershipRefresher({
      debounceMs: 10_000,
      runPass: async () => {
        calls += 1;
        await gate.promise;
        return SUMMARY;
      },
    });
    // `run()` sets `running = true` synchronously before its first await, so
    // by the time this call returns, a second `run()` must see it running.
    const first = r.run();
    await expect(r.run()).rejects.toThrow("ERR_OWNERSHIP_PASS_RUNNING");
    gate.resolve();
    expect(await first).toEqual(SUMMARY);
    expect(calls).toBe(1);
    r.stop();
  });

  test("a trigger() during an on-demand run() sets dirty and gets exactly one follow-up pass", async () => {
    const gate = deferred();
    let calls = 0;
    const r = createOwnershipRefresher({
      debounceMs: 5,
      runPass: async () => {
        calls += 1;
        if (calls === 1) await gate.promise;
        return SUMMARY;
      },
    });
    const first = r.run();
    // `running` is already true here, so this takes the dirty branch instead
    // of scheduling a debounce timer.
    r.trigger();
    gate.resolve();
    await first;
    await tick(40);
    expect(calls).toBe(2);
    r.stop();
  });

  test("a pending debounced timer firing into a running on-demand pass sets dirty, not a second pass", async () => {
    const gate = deferred();
    let calls = 0;
    const r = createOwnershipRefresher({
      debounceMs: 20,
      runPass: async () => {
        calls += 1;
        if (calls === 1) await gate.promise;
        return SUMMARY;
      },
    });
    r.trigger(); // schedules the debounce timer
    const first = r.run(); // starts the pass immediately; running = true
    await tick(60); // let the debounce timer fire while the pass is still in flight
    expect(calls).toBe(1); // fire() saw `running` and only set dirty, no second call yet
    gate.resolve();
    await first;
    await tick(40);
    expect(calls).toBe(2); // the dirty flag got its one follow-up once the pass finished
    r.stop();
  });

  test("stop() during a pass with dirty set makes the finally's fire() find stopped and skip the follow-up", async () => {
    const gate = deferred();
    let calls = 0;
    const r = createOwnershipRefresher({
      debounceMs: 5,
      runPass: async () => {
        calls += 1;
        await gate.promise;
        return SUMMARY;
      },
    });
    const first = r.run();
    r.trigger(); // running -> dirty = true
    r.stop(); // stopped = true
    gate.resolve();
    await first;
    await tick(40);
    expect(calls).toBe(1); // the re-entrant fire() from the finally saw `stopped` and returned
  });

  test("trigger() after stop() starts no pass", async () => {
    let calls = 0;
    const r = createOwnershipRefresher({
      debounceMs: 5,
      runPass: async () => {
        calls += 1;
        return SUMMARY;
      },
    });
    r.stop();
    r.trigger();
    await tick(40);
    expect(calls).toBe(0);
  });

  test("run() rejects with an rpcCode-carrying error while a pass is in flight", async () => {
    let release: (() => void) | undefined;
    const r = createOwnershipRefresher({
      debounceMs: 5,
      runPass: async () => {
        await new Promise<void>((res) => {
          release = res;
        });
        return SUMMARY;
      },
    });

    const first = r.run();
    const err = await r.run().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OwnershipRefresherError);
    expect((err as OwnershipRefresherError).rpcCode).toBe(-32000);
    expect((err as Error).message).toContain("ERR_OWNERSHIP_PASS_RUNNING");

    release?.();
    await first;
    r.stop();
  });

  test("run() after stop() rejects with an rpcCode-carrying error", async () => {
    const r = createOwnershipRefresher({ debounceMs: 5, runPass: async () => SUMMARY });
    r.stop();
    const err = await r.run().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OwnershipRefresherError);
    expect((err as OwnershipRefresherError).rpcCode).toBe(-32000);
    expect((err as Error).message).toContain("ERR_OWNERSHIP_STOPPED");
  });
});
