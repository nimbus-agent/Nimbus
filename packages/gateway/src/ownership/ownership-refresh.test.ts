import { describe, expect, test } from "bun:test";

import type { OwnershipPassSummary } from "./ownership-pass.ts";
import { createOwnershipRefresher } from "./ownership-refresh.ts";

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
});
