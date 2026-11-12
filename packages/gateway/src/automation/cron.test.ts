import { describe, expect, test } from "bun:test";

import {
  CronError,
  isValidTimeZone,
  machineTimeZone,
  nextFire,
  parseCron,
  scheduleRefusal,
} from "./cron.ts";

const utc = (iso: string): number => Date.parse(iso);

describe("parseCron: each field form", () => {
  test("star, number, list, range, step and ranged step", () => {
    const s = parseCron("*/15 1,3 5-7 * 1-5/2");
    expect(s.minutes).toEqual([0, 15, 30, 45]);
    expect(s.hours).toEqual([1, 3]);
    expect(s.daysOfMonth).toEqual([5, 6, 7]);
    expect(s.months).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(s.daysOfWeek).toEqual([1, 3, 5]);
  });

  test("day of week 0 and 7 are both Sunday, and a range through 7 wraps to it", () => {
    expect(parseCron("0 0 * * 7").daysOfWeek).toEqual([0]);
    expect(parseCron("0 0 * * 0,7").daysOfWeek).toEqual([0]);
    expect(parseCron("0 0 * * 5-7").daysOfWeek).toEqual([0, 5, 6]);
  });

  test("the four macros expand and nothing else does", () => {
    expect(parseCron("@hourly").minutes).toEqual([0]);
    expect(parseCron("@daily").hours).toEqual([0]);
    expect(parseCron("@weekly").daysOfWeek).toEqual([0]);
    expect(parseCron("@monthly").daysOfMonth).toEqual([1]);
    for (const m of ["@yearly", "@annually", "@reboot", "@midnight"]) {
      expect(() => parseCron(m), m).toThrow(CronError);
    }
  });

  test("every unsupported form is refused", () => {
    const bad = [
      "",
      "* * * *",
      "* * * * * *",
      "0 0 * JAN *",
      "0 0 * * MON",
      "0 0 L * *",
      "0 0 15W * *",
      "0 0 * * 1#2",
      "0 0 ? * *",
      "60 * * * *",
      "* 24 * * *",
      "* * 0 * *",
      "* * 32 * *",
      "* * * 13 *",
      "* * * * 8",
      "5/10 * * * *",
      "*/0 * * * *",
      "*/x * * * *",
      "10-5 * * * *",
      "1-2-3 * * * *",
      "1//2 * * * *",
      ", * * * *",
      "-1 * * * *",
    ];
    for (const expr of bad) expect(() => parseCron(expr), expr).toThrow(CronError);
  });
});

describe("nextFire", () => {
  test("is strictly after the instant given, and minute-aligned", () => {
    const t = nextFire("*/5 * * * *", "UTC", utc("2026-03-01T10:05:00Z"));
    expect(t).toBe(utc("2026-03-01T10:10:00Z"));
    expect(nextFire("*/5 * * * *", "UTC", utc("2026-03-01T10:04:59Z"))).toBe(
      utc("2026-03-01T10:05:00Z"),
    );
  });

  test("rolls over hour, day, month and year", () => {
    expect(nextFire("0 9 * * *", "UTC", utc("2026-12-31T09:00:00Z"))).toBe(
      utc("2027-01-01T09:00:00Z"),
    );
    expect(nextFire("30 2 1 * *", "UTC", utc("2026-01-31T03:00:00Z"))).toBe(
      utc("2026-02-01T02:30:00Z"),
    );
  });

  test("day of month and day of week are ORed when both are restricted", () => {
    // 2026-03-01 is a Sunday. "the 15th OR any Monday": the first Monday is 2026-03-02.
    expect(nextFire("0 0 15 * 1", "UTC", utc("2026-03-01T00:00:00Z"))).toBe(
      utc("2026-03-02T00:00:00Z"),
    );
    expect(nextFire("0 0 15 * 1", "UTC", utc("2026-03-09T00:00:00Z"))).toBe(
      utc("2026-03-15T00:00:00Z"),
    );
  });

  test("a restricted day of week with a star day of month is ANDed (just the weekday)", () => {
    expect(nextFire("0 0 * * 1", "UTC", utc("2026-03-01T00:00:00Z"))).toBe(
      utc("2026-03-02T00:00:00Z"),
    );
  });

  test("an impossible date never fires", () => {
    expect(nextFire("0 0 30 2 *", "UTC", utc("2026-01-01T00:00:00Z"))).toBeUndefined();
  });

  test("February 29 is found across years", () => {
    expect(nextFire("0 0 29 2 *", "UTC", utc("2026-01-01T00:00:00Z"))).toBe(
      utc("2028-02-29T00:00:00Z"),
    );
  });

  test("a zone shifts the instant", () => {
    // 09:00 in Tokyo (UTC+9, no DST) is 00:00 UTC.
    expect(nextFire("0 9 * * *", "Asia/Tokyo", utc("2026-03-01T00:00:00Z"))).toBe(
      utc("2026-03-02T00:00:00Z"),
    );
  });

  test("DST spring forward, exact: the gap day has no 02:30 fire", () => {
    const afterSaturdayFire = utc("2026-03-07T07:30:00Z"); // 02:30 EST on Mar 7
    const next = nextFire("30 2 * * *", "America/New_York", afterSaturdayFire);
    // Mar 8 02:30 does not exist; the next fire is Mar 9 02:30 EDT = 06:30Z.
    expect(next).toBe(utc("2026-03-09T06:30:00Z"));
  });

  test("DST fall back: an ambiguous local minute fires once, at its first occurrence", () => {
    // America/New_York 2026-11-01: 01:30 happens at 05:30Z (EDT) and 06:30Z (EST).
    const before = utc("2026-11-01T04:00:00Z");
    const first = nextFire("30 1 * * *", "America/New_York", before);
    expect(first).toBe(utc("2026-11-01T05:30:00Z"));
    const second = nextFire("30 1 * * *", "America/New_York", first as number);
    expect(second).toBe(utc("2026-11-02T06:30:00Z")); // Nov 2, 01:30 EST: not the repeated one
  });

  test("an unknown zone is refused", () => {
    expect(() => nextFire("* * * * *", "Mars/Olympus", 0)).toThrow(CronError);
  });
});

describe("zones", () => {
  test("isValidTimeZone", () => {
    expect(isValidTimeZone("Europe/Berlin")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone(" UTC")).toBe(false);
    expect(isValidTimeZone(machineTimeZone())).toBe(true);
  });
});

describe("scheduleRefusal: the five-minute minimum", () => {
  test("accepts */5 and anything slower", () => {
    for (const e of ["*/5 * * * *", "0 * * * *", "0 9 * * 1-5", "@daily", "0,30 * * * *"]) {
      expect(scheduleRefusal(e, "UTC"), e).toBeUndefined();
    }
  });

  test("refuses */1, */2, */4, 0-59/3 and an irregular list under five minutes", () => {
    for (const e of ["* * * * *", "*/1 * * * *", "*/2 * * * *", "*/4 * * * *", "0-59/3 * * * *"]) {
      expect(scheduleRefusal(e, "UTC"), e).toMatch(/every 5 minutes/);
    }
    expect(scheduleRefusal("0,3 * * * *", "UTC")).toMatch(/every 5 minutes/);
    expect(scheduleRefusal("59,0 23,0 * * *", "UTC")).toMatch(/every 5 minutes/);
  });

  test("a caller-chosen minimum interval (the briefing asks for an hour)", () => {
    expect(scheduleRefusal("0,30 * * * *", "UTC", 60)).toMatch(/every 60 minutes/);
    expect(scheduleRefusal("30 8 * * 1-5", "UTC", 60)).toBeUndefined();
    expect(scheduleRefusal("*/5 * * * *", "UTC")).toBeUndefined();
    expect(scheduleRefusal("*/4 * * * *", "UTC")).toMatch(/every 5 minutes/);
  });

  test("refuses a malformed expression, a bad zone and one that never fires", () => {
    expect(scheduleRefusal("nope", "UTC")).toMatch(/five fields/);
    expect(scheduleRefusal("0 0 * * *", "Mars/Olympus")).toMatch(/not a time zone/);
    expect(scheduleRefusal("0 0 30 2 *", "UTC")).toMatch(/never fires/);
  });
});
