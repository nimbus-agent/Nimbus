import { describe, expect, test } from "bun:test";
import type { NimbusIacDriftToml } from "../config/iac-drift-toml.ts";
import { DRIFT_LATE_MS, DRIFT_TICK_MS, IacDriftScheduler } from "./drift-scheduler.ts";

const T0 = Date.UTC(2026, 10, 18, 5, 58);
const SIX = Date.UTC(2026, 10, 18, 6, 0);
const DAY = 24 * 3_600_000;

function harness(
  cfg: () => NimbusIacDriftToml,
  opts: { running?: () => boolean; fail?: boolean; wasRunningAt?: (t: number) => boolean } = {},
) {
  let now = T0;
  const runs: string[] = [];
  const errors: unknown[] = [];
  const timers: { fn?: () => void; cleared: boolean; ms?: number } = { cleared: false };
  const s = new IacDriftScheduler({
    runner: {
      check: ({ startedBy }) => {
        runs.push(startedBy);
        return opts.fail === true ? Promise.reject(new Error("boom")) : Promise.resolve([]);
      },
      running: opts.running ?? (() => false),
      wasRunningAt: opts.wasRunningAt ?? (() => false),
    },
    config: cfg,
    now: () => now,
    onError: (e) => errors.push(e),
    timers: {
      setInterval: (fn, ms) => {
        timers.fn = fn;
        timers.ms = ms;
        return 1;
      },
      clearInterval: () => {
        timers.cleared = true;
      },
    },
  });
  return {
    s,
    runs,
    errors,
    timers,
    at: (t: number) => {
      now = t;
    },
  };
}

const daily: NimbusIacDriftToml = { schedule: "0 6 * * *", tz: "UTC", notify: true };

describe("the scheduled drift check (OR-DRIFT-2)", () => {
  test("off: no schedule, nothing armed, nothing runs", async () => {
    const h = harness(() => ({ ...daily, schedule: undefined }));
    await h.s.tick();
    h.at(SIX + 1);
    await h.s.tick();
    expect(h.s.nextFireAt()).toBeUndefined();
    expect(h.runs).toEqual([]);
  });

  test("arms the next fire, runs once at it, and re-arms; no catch-up", async () => {
    const h = harness(() => daily);
    await h.s.tick();
    expect(h.s.nextFireAt()).toBe(SIX);
    await h.s.tick();
    expect(h.runs).toEqual([]);
    h.at(SIX + 30_000);
    await h.s.tick();
    expect(h.runs).toEqual(["schedule"]);
    expect(h.s.nextFireAt()).toBe(SIX + DAY);
  });

  test("a fire due while a check runs is skipped, never queued", async () => {
    const h = harness(() => daily, { running: () => true });
    await h.s.tick();
    h.at(SIX);
    await h.s.tick();
    expect(h.runs).toEqual([]);
    expect(h.s.nextFireAt()).toBe(SIX + DAY);
  });

  test("start arms at once: a fire due before the first poll is not lost", async () => {
    const h = harness(() => daily);
    h.at(SIX - 30_000);
    h.s.start();
    await Promise.resolve();
    expect(h.s.nextFireAt()).toBe(SIX);
    h.at(SIX + 30_000);
    await h.s.tick();
    expect(h.runs).toEqual(["schedule"]);
    await h.s.retire();
  });

  test("a fire more than the lateness window late (the host slept) is skipped and re-armed", async () => {
    const h = harness(() => daily);
    await h.s.tick();
    h.at(SIX + 6 * 3_600_000);
    await h.s.tick();
    expect(h.runs).toEqual([]);
    expect(h.s.nextFireAt()).toBe(SIX + DAY);
    // Within the window it runs.
    const g = harness(() => daily);
    await g.s.tick();
    g.at(SIX + DRIFT_LATE_MS);
    await g.s.tick();
    expect(g.runs).toEqual(["schedule"]);
  });

  test("a check that was running at the due time skips the fire, even if it finished before the poll", async () => {
    const h = harness(() => daily, { wasRunningAt: (t) => t === SIX });
    await h.s.tick();
    h.at(SIX + 30_000);
    await h.s.tick();
    expect(h.runs).toEqual([]);
  });

  test("start after retire never arms a timer", async () => {
    const h = harness(() => daily);
    await h.s.retire();
    h.s.start();
    expect(h.timers.ms).toBeUndefined();
  });

  test("turning the schedule off disarms it", async () => {
    let cfg: NimbusIacDriftToml = daily;
    const h = harness(() => cfg);
    await h.s.tick();
    expect(h.s.nextFireAt()).toBe(SIX);
    cfg = { ...daily, schedule: undefined };
    await h.s.tick();
    expect(h.s.nextFireAt()).toBeUndefined();
  });

  test("a changed schedule re-arms; a failed run is reported, not thrown", async () => {
    let cfg: NimbusIacDriftToml = daily;
    const h = harness(() => cfg, { fail: true });
    await h.s.tick();
    cfg = { ...daily, schedule: "30 6 * * *" };
    await h.s.tick();
    expect(h.s.nextFireAt()).toBe(SIX + 30 * 60_000);
    h.at(SIX + 30 * 60_000);
    await h.s.tick();
    expect(h.runs).toEqual(["schedule"]);
    expect(h.errors).toHaveLength(1);
  });

  test("a config that throws or a schedule that cannot be computed is reported", async () => {
    const h = harness(() => {
      throw new Error("cfg");
    });
    await h.s.tick();
    const g = harness(() => ({ ...daily, tz: "Mars/Base" }));
    await g.s.tick();
    expect(h.errors).toHaveLength(1);
    expect(g.errors).toHaveLength(1);
    expect(g.s.nextFireAt()).toBeUndefined();
  });

  test("retire waits for a check that is still running", async () => {
    let finish: () => void = () => {};
    let done = false;
    let now = T0;
    const s = new IacDriftScheduler({
      runner: {
        check: () =>
          new Promise((res) => {
            finish = () => {
              done = true;
              res([]);
            };
          }),
        running: () => false,
        wasRunningAt: () => false,
      },
      config: () => daily,
      now: () => now,
    });
    await s.tick();
    now = SIX;
    void s.tick();
    let retired = false;
    const r = s.retire().then(() => {
      retired = true;
    });
    await Promise.resolve();
    expect(retired).toBe(false);
    finish();
    await r;
    expect(done && retired).toBe(true);
  });

  test("start ticks every 60 s, once; retire clears the timer and waits", async () => {
    const h = harness(() => daily);
    h.s.start();
    h.s.start();
    expect(h.timers.ms).toBe(DRIFT_TICK_MS);
    h.timers.fn?.();
    await h.s.retire();
    expect(h.timers.cleared).toBe(true);
    await h.s.retire();
  });
});
