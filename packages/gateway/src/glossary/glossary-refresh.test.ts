import { describe, expect, it, test } from "bun:test";

import type { GlossaryPassSummary } from "./glossary-extract.ts";
import { createGlossaryRefresher } from "./glossary-refresh.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const SUMMARY: GlossaryPassSummary = {
  scanned: 0,
  discovered: 0,
  demoted: 0,
  consolidated: 0,
  upgraded: 0,
  vetoed: 0,
  upgradesVetoed: 0,
  vetoedTerms: [],
  retried: 0,
  llmConfigured: false,
  llmProduced: false,
  aborted: false,
};

test("a trigger runs the pass after the debounce window", async () => {
  let runs = 0;
  const r = createGlossaryRefresher({
    enabled: true,
    debounceMs: 5,
    runPass: async () => {
      runs += 1;
      return SUMMARY;
    },
  });
  r.trigger();
  await Bun.sleep(30);
  expect(runs).toBe(1);
  r.stop();
});

test("a burst of triggers coalesces into one pass", async () => {
  let runs = 0;
  const r = createGlossaryRefresher({
    enabled: true,
    debounceMs: 15,
    runPass: async () => {
      runs += 1;
      return SUMMARY;
    },
  });
  r.trigger();
  r.trigger();
  r.trigger();
  await Bun.sleep(50);
  expect(runs).toBe(1);
  r.stop();
});

test("triggers during an in-flight pass coalesce into exactly one follow-up", async () => {
  // A sync landing mid-pass must not be lost — its items would wait for some
  // later sync, which after the last sync of a session may never come. Three
  // overlapping triggers still yield ONE follow-up, so a slow pass cannot
  // accumulate a backlog.
  let runs = 0;
  const gate = deferred();
  const r = createGlossaryRefresher({
    enabled: true,
    debounceMs: 1,
    runPass: async () => {
      runs += 1;
      if (runs === 1) await gate.promise;
      return SUMMARY;
    },
  });
  r.trigger();
  await Bun.sleep(15);
  r.trigger();
  r.trigger();
  r.trigger();
  await Bun.sleep(15);
  expect(runs).toBe(1);
  gate.resolve();
  await Bun.sleep(25);
  expect(runs).toBe(2);
  r.stop();
});

test("stop aborts the signal handed to an in-flight pass", async () => {
  const gate = deferred();
  let seen: AbortSignal | undefined;
  const r = createGlossaryRefresher({
    enabled: true,
    debounceMs: 1,
    runPass: async (signal) => {
      seen = signal;
      await gate.promise;
      return SUMMARY;
    },
  });
  r.trigger();
  await Bun.sleep(15);
  expect(seen?.aborted).toBe(false);
  r.stop();
  expect(seen?.aborted).toBe(true);
  gate.resolve();
  await Bun.sleep(10);
});

test("stop suppresses the follow-up pass a mid-flight trigger asked for", async () => {
  let runs = 0;
  const gate = deferred();
  const r = createGlossaryRefresher({
    enabled: true,
    debounceMs: 1,
    runPass: async () => {
      runs += 1;
      if (runs === 1) await gate.promise;
      return SUMMARY;
    },
  });
  r.trigger();
  await Bun.sleep(15);
  r.trigger();
  await Bun.sleep(15);
  r.stop();
  gate.resolve();
  await Bun.sleep(25);
  expect(runs).toBe(1);
});

test("disabled never runs the pass", async () => {
  let runs = 0;
  const r = createGlossaryRefresher({
    enabled: false,
    debounceMs: 1,
    runPass: async () => {
      runs += 1;
      return SUMMARY;
    },
  });
  r.trigger();
  await Bun.sleep(20);
  expect(runs).toBe(0);
  r.stop();
});

test("stop cancels a pending trigger", async () => {
  let runs = 0;
  const r = createGlossaryRefresher({
    enabled: true,
    debounceMs: 20,
    runPass: async () => {
      runs += 1;
      return SUMMARY;
    },
  });
  r.trigger();
  r.stop();
  await Bun.sleep(40);
  expect(runs).toBe(0);
});

test("a trigger after stop never runs a pass", async () => {
  // A connector sync can land while shutdown is in progress. This asserts the
  // observable half — no pass runs — which `fire`'s `stopped` check enforces.
  // The `trigger`-side check additionally avoids ARMING a timer (which would
  // hold Bun's event loop open past disposal); that is not observable from
  // here, so this test does not stand in for it.
  let runs = 0;
  const r = createGlossaryRefresher({
    enabled: true,
    debounceMs: 1,
    runPass: async () => {
      runs += 1;
      return SUMMARY;
    },
  });
  r.stop();
  r.trigger();
  await Bun.sleep(20);
  expect(runs).toBe(0);
});

test("a thrown pass does not wedge the refresher", async () => {
  let runs = 0;
  const r = createGlossaryRefresher({
    enabled: true,
    debounceMs: 5,
    runPass: async () => {
      runs += 1;
      throw new Error("boom");
    },
  });
  r.trigger();
  await Bun.sleep(25);
  r.trigger();
  await Bun.sleep(25);
  expect(runs).toBe(2);
  r.stop();
});

describe("runNow", () => {
  it("runs immediately without waiting for the debounce", async () => {
    let ran = 0;
    const r = createGlossaryRefresher({
      enabled: true,
      debounceMs: 60_000,
      runPass: () => {
        ran += 1;
        return Promise.resolve(SUMMARY);
      },
    });
    await r.runNow({ rebuild: false });
    expect(ran).toBe(1);
    r.stop();
  });

  it("forwards the rebuild flag", async () => {
    let sawRebuild: boolean | undefined;
    const r = createGlossaryRefresher({
      enabled: true,
      debounceMs: 1,
      runPass: (_s, o) => {
        sawRebuild = o.rebuild;
        return Promise.resolve(SUMMARY);
      },
    });
    await r.runNow({ rebuild: true });
    expect(sawRebuild).toBe(true);
    r.stop();
  });

  it("rejects a concurrent call instead of awaiting the running pass", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const r = createGlossaryRefresher({
      enabled: true,
      debounceMs: 1,
      runPass: async () => {
        await gate;
        return SUMMARY;
      },
    });
    const first = r.runNow({ rebuild: false });
    expect(r.status()).toBe("running");
    await expect(r.runNow({ rebuild: false })).rejects.toThrow("ERR_GLOSSARY_PASS_RUNNING");
    release?.();
    await first;
    expect(r.status()).toBe("idle");
    r.stop();
  });

  it("rejects when the glossary is disabled", async () => {
    const r = createGlossaryRefresher({
      enabled: false,
      debounceMs: 1,
      runPass: () => Promise.resolve(SUMMARY),
    });
    expect(r.status()).toBe("disabled");
    await expect(r.runNow({ rebuild: false })).rejects.toThrow("ERR_GLOSSARY_DISABLED");
  });

  it("rejects after stop()", async () => {
    const r = createGlossaryRefresher({
      enabled: true,
      debounceMs: 1,
      runPass: () => Promise.resolve(SUMMARY),
    });
    r.stop();
    expect(r.status()).toBe("stopped");
    await expect(r.runNow({ rebuild: false })).rejects.toThrow("ERR_GLOSSARY_STOPPED");
  });

  it("passes the refresher's abort signal so stop() cancels an on-demand pass", async () => {
    let seen: AbortSignal | undefined;
    const r = createGlossaryRefresher({
      enabled: true,
      debounceMs: 1,
      runPass: (s) => {
        seen = s;
        return Promise.resolve(SUMMARY);
      },
    });
    await r.runNow({ rebuild: false });
    expect(seen?.aborted).toBe(false);
    r.stop();
    expect(seen?.aborted).toBe(true);
  });
});
