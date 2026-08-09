import { expect, test } from "bun:test";

import type { PremortemPassResult } from "./premortem-pass.ts";
import { createPremortemRefresher, PremortemRefresherError } from "./premortem-refresh.ts";

const EMPTY: PremortemPassResult = {
  scanned: 0,
  themesWritten: 0,
  demoted: 0,
  prunedEvidence: 0,
  llmCalls: 0,
  noModel: false,
};

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * A pass whose completion the test controls, so "a trigger arrived WHILE a
 * pass was running" is expressed exactly rather than raced against a sleep.
 * Mirrors `decisions/decision-refresh.test.ts`.
 */
function deferred(): { promise: Promise<PremortemPassResult>; resolve: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<PremortemPassResult>((res) => {
    release = () => {
      res(EMPTY);
    };
  });
  return { promise, resolve: () => release() };
}

test("many triggers inside the debounce window run the pass once", async () => {
  let runs = 0;
  const r = createPremortemRefresher({
    debounceMs: 20,
    runPass: async () => {
      runs += 1;
      return EMPTY;
    },
    onError: () => {},
  });
  r.trigger();
  r.trigger();
  r.trigger();
  await sleep(60);
  expect(runs).toBe(1);
  r.stop();
});

test("stop() cancels a pending debounce", async () => {
  let runs = 0;
  const r = createPremortemRefresher({
    debounceMs: 20,
    runPass: async () => {
      runs += 1;
      return EMPTY;
    },
    onError: () => {},
  });
  r.trigger();
  r.stop();
  await sleep(60);
  expect(runs).toBe(0);
});

// The `stopped` guard in `trigger()` is not redundant with the one in
// `fire()`: it prevents scheduling a no-op timer after shutdown at all.
test("trigger() after stop() never runs a pass", async () => {
  let runs = 0;
  const r = createPremortemRefresher({
    debounceMs: 5,
    runPass: async () => {
      runs += 1;
      return EMPTY;
    },
    onError: () => {},
  });
  r.stop();
  r.trigger();
  await sleep(30);
  expect(runs).toBe(0);
});

test("runNow bypasses the debounce and returns the result", async () => {
  const r = createPremortemRefresher({
    debounceMs: 10_000,
    runPass: async () => ({
      scanned: 3,
      themesWritten: 1,
      demoted: 0,
      prunedEvidence: 0,
      llmCalls: 1,
      noModel: false,
    }),
    onError: () => {},
  });
  expect(await r.runNow()).toEqual({
    scanned: 3,
    themesWritten: 1,
    demoted: 0,
    prunedEvidence: 0,
    llmCalls: 1,
    noModel: false,
  });
  r.stop();
});

test("runNow() after stop() rejects with ERR_PREMORTEM_STOPPED and never starts a pass", async () => {
  let runs = 0;
  const r = createPremortemRefresher({
    debounceMs: 5,
    runPass: async () => {
      runs += 1;
      return EMPTY;
    },
    onError: () => {},
  });
  r.stop();

  const err: unknown = await r.runNow().then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PremortemRefresherError);
  expect((err as PremortemRefresherError).message).toContain("ERR_PREMORTEM_STOPPED");
  expect((err as PremortemRefresherError).rpcCode).toBe(-32000);
  expect(runs).toBe(0);
});

test("a second runNow() while one is in flight rejects with ERR_PREMORTEM_PASS_RUNNING", async () => {
  const gate = deferred();
  let runs = 0;
  const r = createPremortemRefresher({
    debounceMs: 5,
    runPass: () => {
      runs += 1;
      return gate.promise;
    },
    onError: () => {},
  });

  const first = r.runNow();
  const err: unknown = await r.runNow().then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PremortemRefresherError);
  expect((err as PremortemRefresherError).message).toContain("ERR_PREMORTEM_PASS_RUNNING");
  // The rejected caller must not have started a second concurrent pass.
  expect(runs).toBe(1);

  gate.resolve();
  await first;
  r.stop();
});

test("a trigger during a run schedules exactly one follow-up", async () => {
  // Not zero (the new data would go unmined until the next sync) and not one
  // per trigger (a busy sync would queue an unbounded backlog of passes).
  const gate = deferred();
  let runs = 0;
  const r = createPremortemRefresher({
    debounceMs: 5,
    runPass: () => {
      runs += 1;
      return runs === 1 ? gate.promise : Promise.resolve(EMPTY);
    },
    onError: () => {},
  });

  r.trigger();
  await sleep(25); // first run in flight
  r.trigger();
  r.trigger();
  await sleep(25); // coalesced into the dirty flag, not run concurrently
  expect(runs).toBe(1);

  gate.resolve();
  await sleep(25);
  expect(runs).toBe(2);
  r.stop();
});

test("a trigger during an on-demand runNow() produces exactly one follow-up pass", async () => {
  const gate = deferred();
  let runs = 0;
  const r = createPremortemRefresher({
    debounceMs: 5,
    runPass: () => {
      runs += 1;
      return runs === 1 ? gate.promise : Promise.resolve(EMPTY);
    },
    onError: () => {},
  });

  const first = r.runNow();
  r.trigger();
  r.trigger();
  r.trigger();
  await sleep(30); // the debounce fires while the on-demand pass is still running
  expect(runs).toBe(1); // no concurrent pass

  gate.resolve();
  await first;
  await sleep(20);
  expect(runs).toBe(2); // one follow-up, not three
  r.stop();
});

// The re-entrant `fire()` re-checks `stopped` instead of duplicating the
// guard, so a shutdown that lands mid-pass cancels the queued follow-up.
test("stop() during an in-flight pass cancels the queued follow-up", async () => {
  const gate = deferred();
  let runs = 0;
  const r = createPremortemRefresher({
    debounceMs: 5,
    runPass: () => {
      runs += 1;
      return runs === 1 ? gate.promise : Promise.resolve(EMPTY);
    },
    onError: () => {},
  });

  r.trigger();
  await sleep(25); // pass 1 running
  r.trigger();
  await sleep(25); // dirty set
  r.stop();

  gate.resolve();
  await sleep(25);
  expect(runs).toBe(1);
});

test("stop() aborts the in-flight pass's signal", async () => {
  let observedAborted = false;
  const r = createPremortemRefresher({
    debounceMs: 5,
    runPass: (signal) =>
      new Promise<PremortemPassResult>((resolve) => {
        signal.addEventListener("abort", () => {
          observedAborted = true;
          resolve(EMPTY);
        });
      }),
    onError: () => {},
  });

  r.trigger();
  await sleep(25); // pass running, listening on its signal
  r.stop();
  await sleep(10);
  expect(observedAborted).toBe(true);
});

test("a throwing pass reaches onError and does not wedge the refresher", async () => {
  const errors: unknown[] = [];
  let runs = 0;
  const r = createPremortemRefresher({
    debounceMs: 5,
    runPass: async () => {
      runs += 1;
      if (runs === 1) throw new Error("boom");
      return EMPTY;
    },
    onError: (e) => errors.push(e),
  });
  r.trigger();
  await sleep(40);
  r.trigger();
  await sleep(40);
  expect(errors).toHaveLength(1);
  expect(runs).toBe(2);
  r.stop();
});

test("a failed on-demand runNow() does not wedge the single-flight guard", async () => {
  let runs = 0;
  const r = createPremortemRefresher({
    debounceMs: 5,
    runPass: async () => {
      runs += 1;
      if (runs === 1) throw new Error("boom");
      return EMPTY;
    },
    onError: () => {},
  });
  await expect(r.runNow()).rejects.toThrow("boom");
  await expect(r.runNow()).resolves.toEqual(EMPTY);
  r.stop();
});
