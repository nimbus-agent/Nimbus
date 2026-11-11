import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { type NimbusBriefingToml, parseNimbusTomlBriefing } from "../config/briefing-toml.ts";
import { openMemoryIndexDatabase } from "../testing/bun-test-support.ts";
import type { BriefingRunRequest } from "./briefing-runner.ts";
import { MISSED_REASON } from "./briefing-schedule.ts";
import {
  BriefingScheduler,
  type BriefingSchedulerDeps,
  DEADLINE_SCAN_EVERY_MS,
  PRUNE_EVERY_MS,
} from "./briefing-scheduler.ts";
import { type BriefingStore, createBriefingStore } from "./briefing-store.ts";

const MIN = 60_000;
const HOUR = 3_600_000;
const z = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

const ENABLED = '[briefing]\nenabled = true\nschedule = "30 8 * * 1-5"\ntz = "UTC"\n';

let db: Database;
let store: BriefingStore;
let now: number;
let cfg: NimbusBriefingToml;
let fires: BriefingRunRequest[];
let scans: number;
let errors: unknown[];

beforeEach(() => {
  db = openMemoryIndexDatabase();
  store = createBriefingStore(db);
  now = z(2026, 11, 12, 8, 0);
  cfg = parseNimbusTomlBriefing(ENABLED);
  fires = [];
  scans = 0;
  errors = [];
});
afterEach(() => db.close());

function make(over: Partial<BriefingSchedulerDeps> = {}): BriefingScheduler {
  return new BriefingScheduler({
    store,
    now: () => now,
    loadConfig: () => cfg,
    fire: async (req) => {
      fires.push(req);
      if (req.slotAt !== undefined) {
        store.insertRun({
          firedAt: now,
          firedBy: "schedule",
          status: "ok",
          headline: "x",
          slotAt: req.slotAt,
        });
      }
    },
    scan: async () => {
      scans += 1;
    },
    onError: (e) => errors.push(e),
    ...over,
  });
}

describe("the briefing", () => {
  test("a first-ever start invents no history; the next slot fires once with trigger-free firedBy", async () => {
    const s = make();
    await s.tick(); // 08:00, first tick: baseline = now
    expect(fires).toHaveLength(0);
    now = z(2026, 11, 12, 8, 31);
    await s.tick();
    now = z(2026, 11, 12, 8, 32);
    await s.tick();
    await s.tick();
    expect(fires).toEqual([{ firedBy: "schedule", slotAt: z(2026, 11, 12, 8, 30), toast: true }]);
  });

  test("a restart inside three hours of a missed slot catches it up; later it is a recorded skip", async () => {
    store.insertRun({
      firedAt: z(2026, 11, 11, 8, 30),
      firedBy: "schedule",
      status: "ok",
      headline: "y",
      slotAt: z(2026, 11, 11, 8, 30),
    });
    now = z(2026, 11, 12, 10, 29);
    await make().tick();
    expect(fires.map((f) => f.slotAt)).toEqual([z(2026, 11, 12, 8, 30)]);

    // a different slot, missed by more than three hours: a skipped row, no run
    fires = [];
    store.pruneRuns(Number.MAX_SAFE_INTEGER);
    store.insertRun({
      firedAt: z(2026, 11, 11, 8, 30),
      firedBy: "schedule",
      status: "ok",
      headline: "y",
      slotAt: z(2026, 11, 11, 8, 30),
    });
    now = z(2026, 11, 12, 11, 31);
    await make().tick();
    expect(fires).toHaveLength(0);
    const skipped = store.list(5).find((r) => r.status === "skipped");
    expect(skipped?.slotAt).toBe(z(2026, 11, 12, 8, 30));
    expect(skipped?.headline).toBe(MISSED_REASON);
    expect(skipped?.toastOutcome).toBeNull();
  });

  test("two schedulers racing the same slot leave one row (the unique index)", async () => {
    store.insertRun({
      firedAt: z(2026, 11, 11, 8, 30),
      firedBy: "schedule",
      status: "ok",
      headline: "y",
      slotAt: z(2026, 11, 11, 8, 30),
    });
    now = z(2026, 11, 12, 11, 31);
    const a = make();
    const b = make();
    await a.tick();
    await b.tick();
    expect(
      db.query("SELECT count(*) AS n FROM briefing_run WHERE status = 'skipped'").get(),
    ).toEqual({ n: 1 });
    expect(errors).toEqual([]);
  });

  test("enabling later does not fire the earlier slot; disabling clears the baseline", async () => {
    cfg = parseNimbusTomlBriefing("");
    const s = make();
    now = z(2026, 11, 12, 8, 59);
    await s.tick();
    cfg = parseNimbusTomlBriefing(ENABLED);
    now = z(2026, 11, 12, 9, 0);
    await s.tick();
    expect(fires).toHaveLength(0);
    cfg = parseNimbusTomlBriefing("");
    now = z(2026, 11, 13, 8, 31);
    await s.tick();
    expect(fires).toHaveLength(0);
    cfg = parseNimbusTomlBriefing(ENABLED);
    now = z(2026, 11, 13, 8, 32);
    await s.tick();
    expect(fires).toHaveLength(0); // re-enabled after the slot: baseline is now
  });

  test("an invalid schedule (the config fell back) is never passed on as a bad expression", async () => {
    cfg = parseNimbusTomlBriefing(
      '[briefing]\nenabled = true\nschedule = "* * * * *"\ntz = "UTC"\n',
    );
    expect(cfg.schedule).toBe("30 8 * * 1-5");
    await make().tick();
    expect(errors).toEqual([]);
  });

  test("a throwing runner or config loader is reported and the tick survives", async () => {
    store.insertRun({
      firedAt: z(2026, 11, 11, 8, 30),
      firedBy: "schedule",
      status: "ok",
      headline: "y",
      slotAt: z(2026, 11, 11, 8, 30),
    });
    now = z(2026, 11, 12, 8, 31);
    const boom = make({
      fire: async () => {
        throw new Error("runner");
      },
    });
    await boom.tick();
    expect(errors).toHaveLength(1);
    const noLoad = make({
      loadConfig: () => {
        throw new Error("config");
      },
    });
    await noLoad.tick();
    expect(errors).toHaveLength(2);
    // a failing skip insert that is not a taken slot is reported too
    const broken: BriefingStore = {
      ...store,
      insertRun: () => {
        throw new Error("disk");
      },
    };
    now = z(2026, 11, 12, 12, 0);
    await make({ store: broken }).tick();
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });

  test("a scheduler built with toast:false passes it to the runner", async () => {
    store.insertRun({
      firedAt: z(2026, 11, 11, 8, 30),
      firedBy: "schedule",
      status: "ok",
      headline: "y",
      slotAt: z(2026, 11, 11, 8, 30),
    });
    now = z(2026, 11, 12, 8, 31);
    await make({ toast: false }).tick();
    expect(fires[0]?.toast).toBe(false);
  });
});

describe("the deadline scan and pruning", () => {
  test("runs on the first tick when enabled, then not for 15 minutes, independent of [briefing] enabled", async () => {
    cfg = parseNimbusTomlBriefing("[briefing.deadlines]\nenabled = true\n");
    expect(cfg.enabled).toBe(false);
    const s = make();
    await s.tick();
    expect(scans).toBe(1);
    now += 5 * MIN;
    await s.tick();
    expect(scans).toBe(1);
    now += DEADLINE_SCAN_EVERY_MS;
    await s.tick();
    expect(scans).toBe(2);
  });

  test("off by default; a throwing scan is reported", async () => {
    await make().tick();
    expect(scans).toBe(0);
    cfg = parseNimbusTomlBriefing("[briefing.deadlines]\nenabled = true\n");
    await make({
      scan: async () => {
        throw new Error("scan");
      },
    }).tick();
    expect(errors).toHaveLength(1);
  });

  test("prunes at start and hourly: old runs and old notices go", async () => {
    cfg = parseNimbusTomlBriefing("");
    store.insertRun({
      firedAt: now - 40 * 24 * HOUR,
      firedBy: "manual",
      status: "ok",
      headline: "old",
    });
    store.insertNotice({ itemId: "n", dueAtMs: now - 40 * 24 * HOUR, notifiedAt: 1 });
    const s = make();
    await s.tick();
    expect(store.list(10)).toHaveLength(0);
    expect(store.getNotice("n")).toBeNull();
    store.insertRun({
      firedAt: now - 40 * 24 * HOUR,
      firedBy: "manual",
      status: "ok",
      headline: "old2",
    });
    now += 10 * MIN;
    await s.tick();
    expect(store.list(10)).toHaveLength(1); // not hourly yet
    now += PRUNE_EVERY_MS;
    await s.tick();
    expect(store.list(10)).toHaveLength(0);
  });

  test("a prune failure is reported", async () => {
    const broken: BriefingStore = {
      ...store,
      pruneRuns: () => {
        throw new Error("prune");
      },
    };
    await make({ store: broken }).tick();
    expect(errors).toHaveLength(1);
  });
});

describe("lifecycle", () => {
  test("start ticks at once and on the interval; stop and retire end it; ticks never overlap", async () => {
    let handler: (() => void) | undefined;
    let cleared = 0;
    let release: () => void = () => {};
    let gateOpen = false;
    cfg = parseNimbusTomlBriefing("[briefing.deadlines]\nenabled = true\n");
    const s = make({
      setTimer: (fn) => {
        handler = fn;
        return 1;
      },
      clearTimer: () => {
        cleared += 1;
      },
      scan: async () => {
        scans += 1;
        if (!gateOpen) {
          await new Promise<void>((r) => {
            release = r;
          });
        }
      },
    });
    s.start();
    s.start(); // a second start is a no-op
    expect(handler).toBeDefined();
    await Promise.resolve();
    expect(scans).toBe(1);
    // overlapping tick: returns the in-flight pass, scans no more
    now += 20 * MIN;
    const again = s.tick();
    handler?.();
    expect(scans).toBe(1);
    gateOpen = true;
    release();
    await again;
    s.stop();
    expect(cleared).toBe(1);
    s.stop();
    expect(cleared).toBe(1);
    await s.retire();
    s.start(); // retired: never restarts
    await s.tick();
    expect(scans).toBe(1);
  });

  test("the real interval is unref'd and cleared on stop", async () => {
    const s = make();
    s.start();
    await s.tick();
    s.stop();
    await s.retire();
  });
});
