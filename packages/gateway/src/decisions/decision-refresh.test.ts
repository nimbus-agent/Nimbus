import { expect, test } from "bun:test";

import type { DecisionPassSummary } from "./decision-extract.ts";
import { createDecisionRefresher, DecisionRefresherError } from "./decision-refresh.ts";

const SUMMARY: DecisionPassSummary = {
  scanned: 0,
  discovered: 0,
  extracted: 0,
  vetoed: 0,
  upgraded: 0,
  failed: 0,
  noModel: 0,
  discoveryComplete: true,
};

/**
 * A pass whose completion the test controls, so "a trigger arrived WHILE a pass
 * was running" is expressed exactly rather than raced against a sleep.
 */
function deferred(): { promise: Promise<DecisionPassSummary>; resolve: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<DecisionPassSummary>((res) => {
    release = () => {
      res(SUMMARY);
    };
  });
  return { promise, resolve: () => release() };
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

test("debounces bursts of triggers into a single run", async () => {
  let runs = 0;
  const r = createDecisionRefresher({
    debounceMs: 5,
    runPass: async () => {
      runs++;
      return {
        scanned: 0,
        discovered: 0,
        extracted: 0,
        vetoed: 0,
        upgraded: 0,
        failed: 0,
        noModel: 0,
        discoveryComplete: true,
      };
    },
  });
  r.trigger();
  r.trigger();
  r.trigger();
  await new Promise((res) => setTimeout(res, 40));
  expect(runs).toBe(1);
  r.stop();
});

test("stop() prevents a pending debounced run", async () => {
  let runs = 0;
  const r = createDecisionRefresher({
    debounceMs: 20,
    runPass: async () => {
      runs++;
      return {
        scanned: 0,
        discovered: 0,
        extracted: 0,
        vetoed: 0,
        upgraded: 0,
        failed: 0,
        noModel: 0,
        discoveryComplete: true,
      };
    },
  });
  r.trigger();
  r.stop();
  await new Promise((res) => setTimeout(res, 50));
  expect(runs).toBe(0);
});

test("run() surfaces the summary to the caller", async () => {
  const r = createDecisionRefresher({
    debounceMs: 5,
    runPass: async () => ({
      scanned: 3,
      discovered: 2,
      extracted: 1,
      vetoed: 1,
      upgraded: 0,
      failed: 0,
      noModel: 0,
      discoveryComplete: true,
    }),
  });
  expect((await r.run()).extracted).toBe(1);
  r.stop();
});

test("a failing pass does not wedge the refresher", async () => {
  let calls = 0;
  const r = createDecisionRefresher({
    debounceMs: 5,
    runPass: async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return {
        scanned: 0,
        discovered: 0,
        extracted: 0,
        vetoed: 0,
        upgraded: 0,
        failed: 0,
        noModel: 0,
        discoveryComplete: true,
      };
    },
  });
  await expect(r.run()).rejects.toThrow("boom");
  await expect(r.run()).resolves.toBeDefined();
  r.stop();
});

test("run() after stop() rejects with ERR_DECISIONS_STOPPED and never starts a pass", async () => {
  let calls = 0;
  const r = createDecisionRefresher({
    debounceMs: 5,
    runPass: () => {
      calls++;
      return Promise.resolve(SUMMARY);
    },
  });
  r.stop();

  const err: unknown = await r.run().then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DecisionRefresherError);
  expect((err as DecisionRefresherError).message).toContain("ERR_DECISIONS_STOPPED");
  // The code the IPC layer re-throws as an `RpcMethodError` (ipc/decisions-rpc.ts).
  expect((err as DecisionRefresherError).rpcCode).toBe(-32000);
  expect(calls).toBe(0);
});

// The `stopped` guard in `trigger()` is not redundant with the one in `fire()`:
// arming a timer after shutdown keeps Bun's event loop alive for `debounceMs`
// just to run a no-op, delaying process exit.
test("trigger() after stop() never runs a pass", async () => {
  let calls = 0;
  const r = createDecisionRefresher({
    debounceMs: 5,
    runPass: () => {
      calls++;
      return Promise.resolve(SUMMARY);
    },
  });
  r.stop();
  r.trigger();
  await sleep(30);
  expect(calls).toBe(0);
});

test("a second run() while one is in flight rejects with ERR_DECISIONS_PASS_RUNNING", async () => {
  const gate = deferred();
  let calls = 0;
  const r = createDecisionRefresher({
    debounceMs: 5,
    runPass: () => {
      calls++;
      return gate.promise;
    },
  });

  const first = r.run();
  const err: unknown = await r.run().then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DecisionRefresherError);
  expect((err as DecisionRefresherError).message).toContain("ERR_DECISIONS_PASS_RUNNING");
  // The rejected caller must not have started a second concurrent pass: both
  // paths write `decision_record` and the pass watermark.
  expect(calls).toBe(1);

  gate.resolve();
  await first;
  r.stop();
});

// The DIRTY flag, on-demand side: a connector sync that lands mid-pass must not
// be lost, and must not queue a second follow-up per trigger either.
test("a burst of triggers during an on-demand run() produces exactly one follow-up pass", async () => {
  const gate = deferred();
  let calls = 0;
  const r = createDecisionRefresher({
    debounceMs: 5,
    runPass: () => {
      calls++;
      return calls === 1 ? gate.promise : Promise.resolve(SUMMARY);
    },
  });

  const first = r.run();
  r.trigger();
  r.trigger();
  r.trigger();
  await sleep(30); // the debounce fires while the on-demand pass is still running
  expect(calls).toBe(1); // no concurrent pass

  gate.resolve();
  await first;
  await sleep(20);
  expect(calls).toBe(2); // one follow-up, not three
  r.stop();
});

// The DIRTY flag, scheduled side: same guarantee when the in-flight pass came
// from the debounce rather than from `run()`.
test("a trigger during a debounced pass produces exactly one follow-up pass", async () => {
  const gate = deferred();
  let calls = 0;
  const r = createDecisionRefresher({
    debounceMs: 5,
    runPass: () => {
      calls++;
      return calls === 1 ? gate.promise : Promise.resolve(SUMMARY);
    },
  });

  r.trigger();
  await sleep(25);
  expect(calls).toBe(1);

  r.trigger();
  await sleep(25);
  expect(calls).toBe(1); // coalesced into the dirty flag, not run concurrently

  gate.resolve();
  await sleep(25);
  expect(calls).toBe(2);
  r.stop();
});

// The re-entrant `fire()` re-checks `stopped` instead of duplicating the guard,
// so a shutdown that lands mid-pass cancels the queued follow-up.
test("stop() during an in-flight pass cancels the queued follow-up", async () => {
  const gate = deferred();
  let calls = 0;
  const r = createDecisionRefresher({
    debounceMs: 5,
    runPass: () => {
      calls++;
      return calls === 1 ? gate.promise : Promise.resolve(SUMMARY);
    },
  });

  r.trigger();
  await sleep(25); // pass 1 running
  r.trigger();
  await sleep(25); // dirty set
  r.stop();

  gate.resolve();
  await sleep(25);
  expect(calls).toBe(1);
});

test("onError observes a debounced pass failure and the refresher stays usable", async () => {
  const errors: unknown[] = [];
  let calls = 0;
  const r = createDecisionRefresher({
    debounceMs: 5,
    runPass: () => {
      calls++;
      return calls === 1 ? Promise.reject(new Error("boom")) : Promise.resolve(SUMMARY);
    },
    onError: (e: unknown) => {
      errors.push(e);
    },
  });

  r.trigger();
  await sleep(30);
  expect(errors).toHaveLength(1);
  expect((errors[0] as Error).message).toBe("boom");

  // A failed scheduled pass must not wedge the single-flight guard.
  await expect(r.run()).resolves.toBeDefined();
  expect(calls).toBe(2);
  r.stop();
});
