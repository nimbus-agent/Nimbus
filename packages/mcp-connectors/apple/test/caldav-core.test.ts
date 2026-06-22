import { describe, expect, it } from "bun:test";
import type { CalendarRef } from "../src/caldav-core.ts";
import { caldavObjectFilename, clampInstances, selectCalendars } from "../src/caldav-core.ts";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const calendars: CalendarRef[] = [
  { url: "https://caldav.example.com/cal/work", displayName: "Work" },
  { url: "https://caldav.example.com/cal/home", displayName: "Home" },
  { url: "https://caldav.example.com/cal/holidays", displayName: "Holidays" },
];

// ---------------------------------------------------------------------------
// selectCalendars
// ---------------------------------------------------------------------------

describe("selectCalendars", () => {
  it("returns all calendars when both include and exclude are empty", () => {
    expect(selectCalendars(calendars, {})).toEqual(calendars);
  });

  it("returns all calendars when both include and exclude are empty arrays", () => {
    expect(selectCalendars(calendars, { include: [], exclude: [] })).toEqual(calendars);
  });

  it("returns only the included calendars (include wins)", () => {
    const result = selectCalendars(calendars, { include: ["Work", "Holidays"] });
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.displayName)).toEqual(["Work", "Holidays"]);
  });

  it("returns an empty list when include names match nothing", () => {
    const result = selectCalendars(calendars, { include: ["Birthdays"] });
    expect(result).toHaveLength(0);
  });

  it("excludes the specified calendars and returns the rest", () => {
    const result = selectCalendars(calendars, { exclude: ["Home"] });
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.displayName)).toEqual(["Work", "Holidays"]);
  });

  it("excludes multiple calendars", () => {
    const result = selectCalendars(calendars, { exclude: ["Work", "Holidays"] });
    expect(result).toHaveLength(1);
    expect(result[0]?.displayName).toBe("Home");
  });

  it("include wins over exclude when both are provided", () => {
    // include is non-empty → use it; exclude is ignored
    const result = selectCalendars(calendars, {
      include: ["Work"],
      exclude: ["Work"],
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.displayName).toBe("Work");
  });

  it("returns all calendars when exclude list matches nothing", () => {
    const result = selectCalendars(calendars, { exclude: ["Birthdays"] });
    expect(result).toHaveLength(3);
  });

  it("works with an empty input array", () => {
    expect(selectCalendars([], { include: ["Work"] })).toEqual([]);
    expect(selectCalendars([], { exclude: ["Work"] })).toEqual([]);
    expect(selectCalendars([], {})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// clampInstances
// ---------------------------------------------------------------------------

describe("clampInstances", () => {
  it("returns all rows when count is below the cap", () => {
    const rows = [1, 2, 3];
    const result = clampInstances(rows, 10);
    expect(result).toHaveLength(3);
    expect(result).toEqual([1, 2, 3]);
  });

  it("returns the original array reference when count equals the cap", () => {
    const rows = [1, 2, 3];
    const result = clampInstances(rows, 3);
    expect(result).toBe(rows);
  });

  it("caps the result at max when count exceeds the cap", () => {
    const rows = [10, 20, 30, 40, 50];
    const result = clampInstances(rows, 3);
    expect(result).toHaveLength(3);
    expect(result).toEqual([10, 20, 30]);
  });

  it("returns an empty array when max is 0", () => {
    const result = clampInstances([1, 2, 3], 0);
    expect(result).toHaveLength(0);
  });

  it("returns an empty array when input is empty", () => {
    const result = clampInstances([], 5);
    expect(result).toHaveLength(0);
  });

  it("works with object arrays", () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
    const result = clampInstances(rows, 2);
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
  });
});

// ---------------------------------------------------------------------------
// caldavObjectFilename
// ---------------------------------------------------------------------------

describe("caldavObjectFilename", () => {
  it("passes through a clean UID", () => {
    expect(caldavObjectFilename("event-abc-123")).toBe("event-abc-123.ics");
  });

  it("preserves URL-unreserved chars and @ (the uid@host form)", () => {
    expect(caldavObjectFilename("abc_1.2~3@icloud.com")).toBe("abc_1.2~3@icloud.com.ics");
  });

  it("strips path separators that would corrupt the href", () => {
    expect(caldavObjectFilename("Q2/Q3-Review")).toBe("Q2Q3-Review.ics");
    expect(caldavObjectFilename("a\\b")).toBe("ab.ics");
  });

  it("strips path-traversal and URL-special characters", () => {
    expect(caldavObjectFilename("../../etc/passwd")).toBe("....etcpasswd.ics");
    expect(caldavObjectFilename("a#b?c%d")).toBe("abcd.ics");
  });

  it("falls back to 'event' when the UID sanitizes to empty", () => {
    expect(caldavObjectFilename("/// ")).toBe("event.ics");
    expect(caldavObjectFilename("")).toBe("event.ics");
  });
});
