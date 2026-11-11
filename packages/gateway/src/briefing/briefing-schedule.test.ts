import { describe, expect, test } from "bun:test";

import { nextFire } from "../automation/cron.ts";
import {
  CATCH_UP_WINDOW_MS,
  MAX_SLOT_STEPS,
  MISSED_REASON,
  planFire,
} from "./briefing-schedule.ts";

const MIN = 60_000;
const HOUR = 3_600_000;
const WEEKDAYS = "30 8 * * 1-5";
const LONDON = "Europe/London";
const z = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

describe("planFire: an ordinary weekday", () => {
  const slot = z(2026, 11, 12, 8, 30); // Thursday, GMT
  const yesterday = z(2026, 11, 11, 8, 30);

  test("just after the slot with yesterday's as the last fire runs it", () => {
    expect(
      planFire({
        schedule: WEEKDAYS,
        tz: LONDON,
        nowMs: slot + MIN,
        baselineMs: yesterday,
        lastSlotAt: yesterday,
      }),
    ).toEqual({ kind: "run", slotAt: slot });
  });

  test("before the slot, and at the weekend, nothing is due", () => {
    expect(
      planFire({
        schedule: WEEKDAYS,
        tz: LONDON,
        nowMs: slot - MIN,
        baselineMs: yesterday,
        lastSlotAt: yesterday,
      }),
    ).toEqual({ kind: "none" });
    const fri = z(2026, 11, 13, 8, 30);
    expect(
      planFire({
        schedule: WEEKDAYS,
        tz: LONDON,
        nowMs: z(2026, 11, 14, 9),
        baselineMs: fri,
        lastSlotAt: fri,
      }),
    ).toEqual({ kind: "none" });
  });
});

describe("planFire: catch-up", () => {
  const slot = z(2026, 11, 12, 8, 30);
  const base = {
    schedule: WEEKDAYS,
    tz: LONDON,
    baselineMs: z(2026, 11, 11, 8, 30),
    lastSlotAt: z(2026, 11, 11, 8, 30),
  };

  test("within three hours it runs, beyond it is a recorded skip", () => {
    expect(planFire({ ...base, nowMs: slot + CATCH_UP_WINDOW_MS - MIN })).toEqual({
      kind: "run",
      slotAt: slot,
    });
    expect(planFire({ ...base, nowMs: slot + CATCH_UP_WINDOW_MS + MIN })).toEqual({
      kind: "skip",
      slotAt: slot,
      reason: MISSED_REASON,
    });
  });

  test("three missed days give ONE action, for the latest slot", () => {
    const monday = z(2026, 11, 9, 8, 30);
    const p = planFire({
      schedule: WEEKDAYS,
      tz: LONDON,
      nowMs: z(2026, 11, 12, 8, 40),
      baselineMs: monday,
      lastSlotAt: monday,
    });
    expect(p).toEqual({ kind: "run", slotAt: slot });
  });
});

describe("planFire: the baseline", () => {
  test("a first-ever start at 08:45 with no history invents none", () => {
    const now = z(2026, 11, 12, 8, 45);
    expect(
      planFire({ schedule: WEEKDAYS, tz: LONDON, nowMs: now, baselineMs: now, lastSlotAt: null }),
    ).toEqual({
      kind: "none",
    });
  });

  test("enabled at 09:00 does not fire the 08:30 slot, but tomorrow's runs", () => {
    const enabledAt = z(2026, 11, 12, 9);
    expect(
      planFire({
        schedule: WEEKDAYS,
        tz: LONDON,
        nowMs: enabledAt + MIN,
        baselineMs: enabledAt,
        lastSlotAt: null,
      }),
    ).toEqual({ kind: "none" });
    const tomorrow = z(2026, 11, 13, 8, 31);
    expect(
      planFire({
        schedule: WEEKDAYS,
        tz: LONDON,
        nowMs: tomorrow,
        baselineMs: enabledAt,
        lastSlotAt: null,
      }),
    ).toEqual({ kind: "run", slotAt: z(2026, 11, 13, 8, 30) });
  });

  test("a restart with yesterday's last slot at 08:40 runs today's", () => {
    const yesterday = z(2026, 11, 11, 8, 30);
    expect(
      planFire({
        schedule: WEEKDAYS,
        tz: LONDON,
        nowMs: z(2026, 11, 12, 8, 40),
        baselineMs: yesterday,
        lastSlotAt: yesterday,
      }),
    ).toEqual({ kind: "run", slotAt: z(2026, 11, 12, 8, 30) });
  });
});

describe("planFire: daylight saving", () => {
  test("Europe/London 30 1 * * *: the spring-forward day has no slot (a stated bound)", () => {
    const last = z(2026, 3, 28, 1, 30);
    expect(
      planFire({
        schedule: "30 1 * * *",
        tz: LONDON,
        nowMs: z(2026, 3, 29, 12),
        baselineMs: last,
        lastSlotAt: last,
      }),
    ).toEqual({ kind: "none" });
  });

  test("Europe/London 30 1 * * *: the repeated fall-back minute fires exactly once", () => {
    const last = z(2026, 10, 24, 0, 30); // 01:30 BST
    const first = planFire({
      schedule: "30 1 * * *",
      tz: LONDON,
      nowMs: z(2026, 10, 25, 0, 45),
      baselineMs: last,
      lastSlotAt: last,
    });
    expect(first).toEqual({ kind: "run", slotAt: z(2026, 10, 25, 0, 30) });
    const after = planFire({
      schedule: "30 1 * * *",
      tz: LONDON,
      nowMs: z(2026, 10, 25, 1, 45),
      baselineMs: last,
      lastSlotAt: z(2026, 10, 25, 0, 30),
    });
    expect(after).toEqual({ kind: "none" });
  });

  test("America/New_York 0 2 * * *: skipped on the spring-forward day, once on fall-back", () => {
    const ny = "America/New_York";
    const mar7 = z(2026, 3, 7, 7);
    expect(
      planFire({
        schedule: "0 2 * * *",
        tz: ny,
        nowMs: z(2026, 3, 8, 12),
        baselineMs: mar7,
        lastSlotAt: mar7,
      }),
    ).toEqual({
      kind: "none",
    });
    const oct31 = z(2026, 10, 31, 6);
    expect(
      planFire({
        schedule: "0 2 * * *",
        tz: ny,
        nowMs: z(2026, 11, 1, 7, 30),
        baselineMs: oct31,
        lastSlotAt: oct31,
      }),
    ).toEqual({
      kind: "run",
      slotAt: z(2026, 11, 1, 7),
    });
  });

  test("30 8 * * 1-5 fires at 08:30 local on both sides of both changes", () => {
    const fri = z(2026, 3, 27, 8, 30); // GMT
    expect(
      planFire({
        schedule: WEEKDAYS,
        tz: LONDON,
        nowMs: z(2026, 3, 30, 7, 31),
        baselineMs: fri,
        lastSlotAt: fri,
      }),
    ).toEqual({
      kind: "run",
      slotAt: z(2026, 3, 30, 7, 30), // 08:30 BST
    });
    const fri2 = z(2026, 10, 23, 7, 30); // BST
    expect(
      planFire({
        schedule: WEEKDAYS,
        tz: LONDON,
        nowMs: z(2026, 10, 26, 8, 31),
        baselineMs: fri2,
        lastSlotAt: fri2,
      }),
    ).toEqual({
      kind: "run",
      slotAt: z(2026, 10, 26, 8, 30), // 08:30 GMT
    });
  });
});

describe("planFire: the lookback clamp", () => {
  test("a last fire ten days old does not iterate hundreds of slots", () => {
    let calls = 0;
    const counting = (expr: string, tz: string, after: number) => {
      calls += 1;
      return nextFire(expr, tz, after);
    };
    const now = z(2026, 11, 12, 12, 30);
    const old = now - 10 * 24 * HOUR;
    const p = planFire({
      schedule: "0 * * * *",
      tz: "UTC",
      nowMs: now,
      baselineMs: old,
      lastSlotAt: old,
      next: counting,
    });
    expect(p).toEqual({ kind: "run", slotAt: z(2026, 11, 12, 12) });
    expect(calls).toBeLessThanOrEqual(27);
  });

  test("the loop is bounded even by a schedule source that never advances past now", () => {
    let calls = 0;
    const p = planFire({
      schedule: "x",
      tz: "UTC",
      nowMs: 1_000_000_000_000,
      baselineMs: 0,
      lastSlotAt: null,
      next: (_e, _t, after) => {
        calls += 1;
        return after + 1;
      },
    });
    expect(calls).toBe(MAX_SLOT_STEPS);
    expect(p.kind).toBe("skip");
  });

  test("an unschedulable expression yields nothing", () => {
    expect(
      planFire({
        schedule: "x",
        tz: "UTC",
        nowMs: 5,
        baselineMs: 0,
        lastSlotAt: null,
        next: () => undefined,
      }),
    ).toEqual({ kind: "none" });
  });
});
