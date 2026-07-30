import { expect, test } from "bun:test";

import { createGlossaryRefresher } from "./glossary-refresh.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("a trigger runs the pass after the debounce window", async () => {
  let runs = 0;
  const r = createGlossaryRefresher({
    enabled: true,
    debounceMs: 5,
    runPass: async () => {
      runs += 1;
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
    },
  });
  r.trigger();
  r.trigger();
  r.trigger();
  await Bun.sleep(50);
  expect(runs).toBe(1);
  r.stop();
});

test("a trigger during an in-flight pass is dropped, not queued", async () => {
  let runs = 0;
  const gate = deferred();
  const r = createGlossaryRefresher({
    enabled: true,
    debounceMs: 1,
    runPass: async () => {
      runs += 1;
      await gate.promise;
    },
  });
  r.trigger();
  await Bun.sleep(15);
  r.trigger();
  await Bun.sleep(15);
  gate.resolve();
  await Bun.sleep(15);
  expect(runs).toBe(1);
  r.stop();
});

test("disabled never runs the pass", async () => {
  let runs = 0;
  const r = createGlossaryRefresher({
    enabled: false,
    debounceMs: 1,
    runPass: async () => {
      runs += 1;
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
    },
  });
  r.trigger();
  r.stop();
  await Bun.sleep(40);
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
