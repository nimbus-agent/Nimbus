import { describe, expect, test } from "bun:test";

import { dateKeyInZone, dateKeyOf, dayRange, eventOnDay } from "./briefing-day.ts";

const HOUR = 3_600_000;

describe("dayRange", () => {
  test("an ordinary day is local midnight to local midnight", () => {
    const d = dayRange(Date.UTC(2026, 10, 12, 8, 30), "Europe/London");
    expect(d.dateKey).toBe("2026-11-12");
    expect(d.label).toBe("Thursday 2026-11-12");
    expect(d.startMs).toBe(Date.UTC(2026, 10, 12));
    expect(d.endMs - d.startMs).toBe(24 * HOUR);
  });

  test.each([
    ["Europe/London", Date.UTC(2026, 2, 29, 12), 23],
    ["Europe/London", Date.UTC(2026, 9, 25, 12), 25],
    ["America/New_York", Date.UTC(2026, 2, 8, 18), 23],
    ["America/New_York", Date.UTC(2026, 10, 1, 18), 25],
  ])("%s on a DST change day is %i h", (zone, now, hours) => {
    const d = dayRange(now, zone);
    expect(d.endMs - d.startMs).toBe(hours * HOUR);
  });

  test("a zone whose midnight is skipped still returns a finite range", () => {
    // America/Sao_Paulo before 2019 jumped 00:00 -> 01:00 in November.
    const d = dayRange(Date.UTC(2018, 10, 4, 12), "America/Sao_Paulo");
    expect(Number.isFinite(d.startMs)).toBe(true);
    expect(d.endMs).toBeGreaterThan(d.startMs);
    expect(d.endMs - d.startMs).toBeLessThanOrEqual(25 * HOUR);
  });

  test("an unknown zone throws", () => {
    expect(() => dayRange(0, "Mars/Base")).toThrow(RangeError);
  });
});

describe("dateKey helpers", () => {
  test("padding and zone conversion", () => {
    expect(dateKeyOf(5, 3, 9)).toBe("0005-03-09");
    expect(dateKeyInZone(Date.UTC(2026, 10, 12, 23, 30), "Asia/Tokyo")).toBe("2026-11-13");
    expect(dateKeyInZone(0, "Mars/Base")).toBeUndefined();
  });
});

describe("eventOnDay", () => {
  const day = dayRange(Date.UTC(2026, 10, 12, 12), "UTC");
  const timed = (startMs: number, endMs: number) => ({ startMs, endMs, allDay: false });

  test("timed overlap, half-open", () => {
    expect(eventOnDay(timed(day.startMs + HOUR, day.startMs + 2 * HOUR), day, "UTC")).toBe(true);
    // spans midnight into the day
    expect(eventOnDay(timed(day.startMs - HOUR, day.startMs + HOUR), day, "UTC")).toBe(true);
    // spans midnight out of the day
    expect(eventOnDay(timed(day.endMs - HOUR, day.endMs + HOUR), day, "UTC")).toBe(true);
    // ends exactly at the start
    expect(eventOnDay(timed(day.startMs - HOUR, day.startMs), day, "UTC")).toBe(false);
    // starts exactly at the end
    expect(eventOnDay(timed(day.endMs, day.endMs + HOUR), day, "UTC")).toBe(false);
  });

  test("a zero-length event counts when it starts inside the day", () => {
    expect(eventOnDay(timed(day.startMs, day.startMs), day, "UTC")).toBe(true);
    expect(eventOnDay(timed(day.startMs + HOUR, day.startMs + HOUR), day, "UTC")).toBe(true);
    expect(eventOnDay(timed(day.startMs - HOUR, day.startMs - HOUR), day, "UTC")).toBe(false);
  });

  test("an all-day event is compared by calendar date in the GATEWAY zone, not the briefing zone", () => {
    // Written in Asia/Tokyo: 2026-11-12 00:00 JST = 2026-11-11 15:00Z, exclusive end 2026-11-13 JST.
    const ev = {
      startMs: Date.UTC(2026, 10, 11, 15),
      endMs: Date.UTC(2026, 10, 12, 15),
      allDay: true,
    };
    // The briefing day is 2026-11-12 in UTC: the instants alone would put the event on the 11th.
    expect(eventOnDay(ev, day, "Asia/Tokyo")).toBe(true);
    const next = dayRange(Date.UTC(2026, 10, 13, 12), "UTC");
    expect(eventOnDay(ev, next, "Asia/Tokyo")).toBe(false);
  });

  test("a multi-day all-day event covers each date and not the exclusive end date", () => {
    const ev = { startMs: Date.UTC(2026, 10, 11), endMs: Date.UTC(2026, 10, 14), allDay: true };
    for (const dd of [11, 12, 13]) {
      expect(eventOnDay(ev, dayRange(Date.UTC(2026, 10, dd, 5), "UTC"), "UTC")).toBe(true);
    }
    expect(eventOnDay(ev, dayRange(Date.UTC(2026, 10, 14, 5), "UTC"), "UTC")).toBe(false);
    expect(eventOnDay(ev, dayRange(Date.UTC(2026, 10, 10, 5), "UTC"), "UTC")).toBe(false);
  });

  test("an all-day event with no usable end covers its start date only; a bad zone covers nothing", () => {
    const ev = { startMs: Date.UTC(2026, 10, 12), endMs: Date.UTC(2026, 10, 12), allDay: true };
    expect(eventOnDay(ev, day, "UTC")).toBe(true);
    expect(eventOnDay(ev, dayRange(Date.UTC(2026, 10, 13, 5), "UTC"), "UTC")).toBe(false);
    expect(eventOnDay(ev, day, "Mars/Base")).toBe(false);
  });
});
