import { describe, expect, test } from "bun:test";

import { CostReportPeriodError, reportPeriods } from "./cost-report-period.ts";

const BERLIN = "Europe/Berlin";
const LA = "America/Los_Angeles";
/** An instant given as a UTC wall clock. */
const at = (iso: string): number => Date.parse(`${iso}Z`);
const span = (p: ReturnType<typeof reportPeriods>) => ({
  range: [p.range.fromDay, p.range.toDay],
  previous: [p.previous.fromDay, p.previous.toDay],
  weekStart: p.weekStart,
});

describe("reportPeriods: week", () => {
  test("on a Wednesday the report covers the previous full Monday to Sunday", () => {
    expect(span(reportPeriods("week", BERLIN, at("2026-11-25T09:00:00")))).toEqual({
      range: ["2026-11-16", "2026-11-22"],
      previous: ["2026-11-09", "2026-11-15"],
      weekStart: "2026-11-16",
    });
    expect(reportPeriods("week", BERLIN, at("2026-11-25T09:00:00")).range.label).toBe(
      "week of Monday 2026-11-16",
    );
  });

  test("the zone decides which day it is at the edges of a day", () => {
    // Monday 00:30 in Berlin is still Sunday 23:30 UTC: the report is for the week that just ended.
    expect(span(reportPeriods("week", BERLIN, at("2026-11-22T23:30:00"))).range).toEqual([
      "2026-11-16",
      "2026-11-22",
    ]);
    // Sunday 23:30 in Los Angeles is already Monday 07:30 UTC: the week has not ended there yet.
    expect(span(reportPeriods("week", LA, at("2026-11-23T07:30:00"))).range).toEqual([
      "2026-11-09",
      "2026-11-15",
    ]);
    expect(span(reportPeriods("week", "UTC", at("2026-11-23T07:30:00"))).range).toEqual([
      "2026-11-16",
      "2026-11-22",
    ]);
  });

  test("weeks across the 2026 DST changes stay seven calendar days", () => {
    for (const [zone, iso] of [
      [BERLIN, "2026-03-31T10:00:00"], // EU spring forward 2026-03-29
      [BERLIN, "2026-10-27T10:00:00"], // EU fall back 2026-10-25
      [LA, "2026-03-10T18:00:00"], // US spring forward 2026-03-08
      [LA, "2026-11-03T18:00:00"], // US fall back 2026-11-01
    ] as const) {
      const p = reportPeriods("week", zone, at(iso));
      const days = (Date.parse(p.range.toDay) - Date.parse(p.range.fromDay)) / 86_400_000 + 1;
      expect(days).toBe(7);
      expect(new Date(Date.parse(p.range.fromDay)).getUTCDay()).toBe(1);
    }
  });

  test("across the year boundary", () => {
    expect(span(reportPeriods("week", BERLIN, at("2027-01-03T12:00:00")))).toEqual({
      range: ["2026-12-21", "2026-12-27"],
      previous: ["2026-12-14", "2026-12-20"],
      weekStart: "2026-12-21",
    });
    expect(span(reportPeriods("week", BERLIN, at("2027-01-05T12:00:00"))).range).toEqual([
      "2026-12-28",
      "2027-01-03",
    ]);
  });
});

describe("reportPeriods: month and <N>d", () => {
  test("month is the previous calendar month, and previous the one before it", () => {
    expect(span(reportPeriods("month", BERLIN, at("2027-01-10T12:00:00")))).toEqual({
      range: ["2026-12-01", "2026-12-31"],
      previous: ["2026-11-01", "2026-11-30"],
      weekStart: null,
    });
    expect(span(reportPeriods("month", BERLIN, at("2026-03-15T12:00:00")))).toEqual({
      range: ["2026-02-01", "2026-02-28"],
      previous: ["2026-01-01", "2026-01-31"],
      weekStart: null,
    });
    expect(reportPeriods("month", BERLIN, at("2026-03-15T12:00:00")).range.label).toBe(
      "February 2026",
    );
    // 2028 is a leap year.
    expect(span(reportPeriods("month", "UTC", at("2028-03-02T00:00:00"))).range).toEqual([
      "2028-02-01",
      "2028-02-29",
    ]);
  });

  test("<N>d ends yesterday in the zone, and previous is the N days before", () => {
    expect(span(reportPeriods("7d", BERLIN, at("2026-11-25T09:00:00")))).toEqual({
      range: ["2026-11-18", "2026-11-24"],
      previous: ["2026-11-11", "2026-11-17"],
      weekStart: null,
    });
    // 23:30 UTC on the 25th is already the 26th in Berlin.
    expect(span(reportPeriods("1d", BERLIN, at("2026-11-25T23:30:00"))).range).toEqual([
      "2026-11-25",
      "2026-11-25",
    ]);
    expect(reportPeriods("30d", BERLIN, at("2026-11-25T09:00:00")).range.label).toBe(
      "the 30 days to 2026-11-24",
    );
  });

  test("a bad period or zone throws", () => {
    expect(() => reportPeriods("year", BERLIN, Date.now())).toThrow(CostReportPeriodError);
    expect(() => reportPeriods("0d", BERLIN, Date.now())).toThrow(CostReportPeriodError);
    expect(() => reportPeriods("week", "Mars/Olympus", Date.now())).toThrow(CostReportPeriodError);
  });
});
