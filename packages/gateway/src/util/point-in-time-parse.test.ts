import { describe, expect, test } from "bun:test";

import { AtTimeError, parseAtParam, parseAtTime } from "./point-in-time-parse.ts";

const NOW = Date.UTC(2026, 10, 12, 10, 0, 0); // 2026-11-12T10:00:00Z
const LONDON = "Europe/London";
const NY = "America/New_York";

function at(raw: string, zone = LONDON, now = NOW): number {
  return parseAtTime(raw, now, zone);
}

describe("parseAtTime - absolute forms", () => {
  test("an ISO instant with Z or an offset ignores the zone", () => {
    expect(at("2026-11-11T09:00:00Z", NY)).toBe(Date.UTC(2026, 10, 11, 9));
    expect(at("2026-11-11T09:00Z", NY)).toBe(Date.UTC(2026, 10, 11, 9));
    expect(at("2026-11-11T09:00:00+02:00", NY)).toBe(Date.UTC(2026, 10, 11, 7));
    expect(at("2026-11-11T09:00-05:30", NY)).toBe(Date.UTC(2026, 10, 11, 14, 30));
    expect(at("2026-11-11 09:00:00z", NY)).toBe(Date.UTC(2026, 10, 11, 9));
  });

  test("a local date-time or date is read in the given zone", () => {
    expect(at("2026-11-11T09:00", NY)).toBe(Date.UTC(2026, 10, 11, 14));
    expect(at("2026-11-11T09:00:30", LONDON)).toBe(Date.UTC(2026, 10, 11, 9, 0, 30));
    expect(at("2026-11-11 09:00", LONDON)).toBe(Date.UTC(2026, 10, 11, 9));
    expect(at("2026-11-11", NY)).toBe(Date.UTC(2026, 10, 11, 5));
  });

  test("whitespace is trimmed", () => {
    expect(at("  2026-11-11T09:00Z  ")).toBe(Date.UTC(2026, 10, 11, 9));
  });
});

describe("parseAtTime - keyword forms", () => {
  test("yesterday and today are the zone's own days", () => {
    // 2026-11-12T00:30Z is still 11 November in New York.
    const now = Date.UTC(2026, 10, 12, 0, 30);
    expect(at("yesterday-09:00", NY, now)).toBe(Date.UTC(2026, 10, 10, 14));
    expect(at("today-09:00", NY, now)).toBe(Date.UTC(2026, 10, 11, 14));
    expect(at("yesterday-09:00", LONDON, now)).toBe(Date.UTC(2026, 10, 11, 9));
  });

  test("keywords are case-insensitive", () => {
    expect(at("YESTERDAY-09:00")).toBe(Date.UTC(2026, 10, 11, 9));
    expect(at("Today-08:30")).toBe(Date.UTC(2026, 10, 12, 8, 30));
  });

  test("yesterday crosses a month boundary", () => {
    const now = Date.UTC(2026, 11, 1, 12);
    expect(at("yesterday-23:59", LONDON, now)).toBe(Date.UTC(2026, 10, 30, 23, 59));
  });

  test("a nonexistent local time resolves with the offset before the gap", () => {
    const londonGap = Date.UTC(2026, 2, 29, 12); // clocks go 01:00 -> 02:00
    expect(at("today-01:30", LONDON, londonGap)).toBe(Date.UTC(2026, 2, 29, 1, 30));
    const nyGap = Date.UTC(2026, 2, 8, 20); // 02:00 -> 03:00
    expect(at("today-02:30", NY, nyGap)).toBe(Date.UTC(2026, 2, 8, 7, 30));
  });

  test("a repeated local time resolves to its first occurrence", () => {
    const now = Date.UTC(2026, 9, 25, 12); // London falls back 02:00 BST -> 01:00 GMT
    expect(at("today-01:30", LONDON, now)).toBe(Date.UTC(2026, 9, 25, 0, 30));
  });
});

describe("parseAtTime - relative forms", () => {
  test.each([
    ["-2h", 2 * 3_600_000],
    ["-30m", 30 * 60_000],
    ["-1d", 86_400_000],
    ["-90s", 90_000],
    ["-1w", 604_800_000],
    ["-0h", 0],
    ["-2 H", 2 * 3_600_000],
  ])("%s", (raw, ago) => {
    expect(at(raw)).toBe(NOW - ago);
  });
});

describe("parseAtTime - refusals name the accepted forms", () => {
  test.each([
    ["empty", ""],
    ["blank", "   "],
    ["yesterday with no time", "yesterday"],
    ["a bad hour", "yesterday-25:00"],
    ["a bad minute", "today-09:60"],
    ["tomorrow", "tomorrow-09:00"],
    ["a plus offset", "+2h"],
    ["a malformed ISO", "2026-1-1T9:00"],
    ["words", "last tuesday"],
    ["a nonexistent date", "2026-02-30"],
    ["a nonexistent local time of day", "2026-11-11T25:00"],
    ["a nonexistent second", "2026-11-11T09:00:61"],
    ["a nonexistent date with an offset", "2026-02-30T09:00Z"],
    ["an impossible UTC offset", "2026-11-11T09:00+25:00"],
    ["an impossible UTC offset minute", "2026-11-11T09:00+01:75"],
  ])("%s", (_label, raw) => {
    let err: unknown;
    try {
      at(raw);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AtTimeError);
    expect((err as AtTimeError).message).toContain("Accepted forms");
  });

  test("an unknown zone is refused for zone-relative forms", () => {
    expect(() => at("2026-11-11T09:00", "Mars/Olympus")).toThrow(/Unknown time zone/);
    expect(() => at("today-09:00", "Mars/Olympus")).toThrow(/Unknown time zone/);
  });

  test("an unknown zone does not matter for an absolute or relative instant", () => {
    expect(at("2026-11-11T09:00Z", "Mars/Olympus")).toBe(Date.UTC(2026, 10, 11, 9));
    expect(at("-1h", "Mars/Olympus")).toBe(NOW - 3_600_000);
  });

  test("an instant in the future of now is refused", () => {
    expect(() => at("2026-11-12T10:00:01Z")).toThrow(/future/);
    expect(() => at("today-23:00")).toThrow(/future/);
    expect(at("2026-11-12T10:00:00Z")).toBe(NOW);
  });

  test("an instant before 2000-01-01 is refused", () => {
    expect(() => at("1999-12-31T23:59Z")).toThrow(/before 2000/);
    expect(at("2000-01-01T00:00Z")).toBe(Date.UTC(2000, 0, 1));
  });

  test("the default zone is the gateway's own", () => {
    expect(parseAtTime("2026-11-11T09:00Z", NOW)).toBe(Date.UTC(2026, 10, 11, 9));
  });
});

describe("parseAtParam", () => {
  test("absent and null mean no point-in-time", () => {
    expect(parseAtParam(undefined, NOW, LONDON)).toBeUndefined();
    expect(parseAtParam(null, NOW, LONDON)).toBeUndefined();
  });

  test("a usable string is parsed", () => {
    expect(parseAtParam("-1h", NOW, LONDON)).toBe(NOW - 3_600_000);
  });

  test("a present but unusable value is refused, never ignored", () => {
    expect(() => parseAtParam(5, NOW, LONDON)).toThrow(AtTimeError);
    expect(() => parseAtParam("", NOW, LONDON)).toThrow(AtTimeError);
    expect(() => parseAtParam({}, NOW, LONDON)).toThrow(/time string/);
  });

  test("the default zone is the gateway's own", () => {
    expect(parseAtParam("2026-11-11T09:00Z", NOW)).toBe(Date.UTC(2026, 10, 11, 9));
  });
});
