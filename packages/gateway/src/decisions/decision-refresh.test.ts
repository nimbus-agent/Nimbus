import { expect, test } from "bun:test";

import { createDecisionRefresher } from "./decision-refresh.ts";

test("debounces bursts of triggers into a single run", async () => {
  let runs = 0;
  const r = createDecisionRefresher({
    debounceMs: 5,
    runPass: async () => {
      runs++;
      return { scanned: 0, discovered: 0, extracted: 0, vetoed: 0, upgraded: 0, failed: 0 };
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
      return { scanned: 0, discovered: 0, extracted: 0, vetoed: 0, upgraded: 0, failed: 0 };
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
      return { scanned: 0, discovered: 0, extracted: 0, vetoed: 0, upgraded: 0, failed: 0 };
    },
  });
  await expect(r.run()).rejects.toThrow("boom");
  await expect(r.run()).resolves.toBeDefined();
  r.stop();
});
