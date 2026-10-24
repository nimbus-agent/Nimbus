import { describe, expect, test } from "bun:test";
import { createLiveEnabled, type LiveEnabledDeps } from "./push-live-enabled.ts";

type Harness = {
  deps: LiveEnabledDeps;
  state: { version: number; value: boolean | "throw"; now: number };
  loads: { n: number };
  reconciles: Array<[boolean, number]>;
  logs: Array<{ obj: Record<string, unknown>; msg: string }>;
};

function harness(checkMs?: number): Harness {
  const state: Harness["state"] = { version: 1, value: false, now: 1_000 };
  const loads = { n: 0 };
  const reconciles: Array<[boolean, number]> = [];
  const logs: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const deps: LiveEnabledDeps = {
    version: () => state.version,
    load: () => {
      loads.n += 1;
      if (state.value === "throw") throw new Error("read failed");
      return state.value;
    },
    reconcile: (enabled, nowMs) => {
      reconciles.push([enabled, nowMs]);
    },
    now: () => state.now,
    logger: {
      error: (obj, msg) => {
        logs.push({ obj, msg });
      },
    },
    ...(checkMs === undefined ? {} : { checkMs }),
  };
  return { deps, state, loads, reconciles, logs };
}

describe("createLiveEnabled", () => {
  test("isEnabled returns the boot value without loading while the version is unchanged", () => {
    const h = harness();
    const live = createLiveEnabled(h.deps, { version: 1, enabled: true });
    expect(live.isEnabled()).toBe(true);
    expect(h.loads.n).toBe(0);
  });

  test("a version change reloads once and reconciles with the new value and now()", () => {
    const h = harness();
    const live = createLiveEnabled(h.deps, { version: 1, enabled: false });
    h.state.value = true;
    h.state.version = 2;
    h.state.now = 5_000;
    expect(live.isEnabled()).toBe(true);
    expect(live.isEnabled()).toBe(true);
    expect(h.loads.n).toBe(1);
    expect(h.reconciles).toEqual([[true, 5_000]]);
  });

  test("an unchanged value after a version bump reconciles nothing", () => {
    const h = harness();
    const live = createLiveEnabled(h.deps, { version: 1, enabled: true });
    h.state.value = true;
    h.state.version = 2;
    expect(live.isEnabled()).toBe(true);
    expect(h.loads.n).toBe(1);
    expect(h.reconciles).toEqual([]);
  });

  test("a disable after enable reconciles false", () => {
    const h = harness();
    const live = createLiveEnabled(h.deps, { version: 1, enabled: true });
    h.state.value = false;
    h.state.version = 2;
    h.state.now = 7_000;
    expect(live.isEnabled()).toBe(false);
    expect(h.reconciles).toEqual([[false, 7_000]]);
  });

  test("a load that throws keeps the last value, logs once for that version, and does not throw", () => {
    const h = harness();
    const live = createLiveEnabled(h.deps, { version: 1, enabled: true });
    h.state.value = "throw";
    h.state.version = 2;
    expect(live.isEnabled()).toBe(true);
    expect(live.isEnabled()).toBe(true);
    expect(h.loads.n).toBe(2);
    expect(h.logs).toHaveLength(1);
    expect(h.reconciles).toEqual([]);
  });

  test("a failed load is retried silently and recovers at the same version", () => {
    const h = harness();
    const live = createLiveEnabled(h.deps, { version: 1, enabled: false });
    h.state.value = "throw";
    h.state.version = 2;
    expect(live.isEnabled()).toBe(false);
    h.state.value = true;
    h.state.now = 9_000;
    expect(live.isEnabled()).toBe(true);
    expect(h.reconciles).toEqual([[true, 9_000]]);
    expect(h.logs).toHaveLength(1);
  });

  test("a reconcile that throws keeps the old value and version, logs once, and retries", () => {
    const h = harness();
    let failNext = true;
    const deps: LiveEnabledDeps = {
      ...h.deps,
      reconcile: (enabled, nowMs) => {
        if (failNext) {
          failNext = false;
          throw new Error("db locked");
        }
        h.reconciles.push([enabled, nowMs]);
      },
    };
    const live = createLiveEnabled(deps, { version: 1, enabled: false });
    h.state.value = true;
    h.state.version = 2;
    h.state.now = 4_000;
    expect(live.isEnabled()).toBe(false);
    expect(h.logs).toHaveLength(1);
    expect(h.reconciles).toEqual([]);
    expect(live.isEnabled()).toBe(true);
    expect(h.reconciles).toEqual([[true, 4_000]]);
    expect(h.logs).toHaveLength(1);
  });

  test("start polls; stop clears the timer and a later version change is not polled", async () => {
    const h = harness(5);
    const live = createLiveEnabled(h.deps, { version: 1, enabled: false });
    live.start();
    live.start();
    h.state.value = true;
    h.state.version = 2;
    await Bun.sleep(40);
    expect(h.reconciles).toEqual([[true, 1_000]]);
    expect(h.loads.n).toBe(1);

    live.stop();
    live.stop();
    h.state.value = false;
    h.state.version = 3;
    await Bun.sleep(40);
    expect(h.loads.n).toBe(1);
    // A direct read after stop still answers the last value and does not reload.
    expect(live.isEnabled()).toBe(true);
    expect(h.loads.n).toBe(1);
  });
});
