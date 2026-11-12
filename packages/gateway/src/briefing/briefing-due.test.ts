import { describe, expect, test } from "bun:test";

import { classifyDue, dueInstant } from "./briefing-due.ts";

describe("dueInstant", () => {
  test("a Jira date-only due date ends at the END of that date in the briefing zone", () => {
    const stored = Date.parse("2026-11-12"); // 00:00 UTC
    // 2026-11-13 00:00 PST = 08:00 UTC
    expect(dueInstant("jira", stored, "America/Los_Angeles")).toBe(Date.UTC(2026, 10, 13, 8));
    expect(dueInstant("jira", stored, "Asia/Tokyo")).toBe(Date.UTC(2026, 10, 12, 15));
    expect(dueInstant("linear", stored, "UTC")).toBe(Date.UTC(2026, 10, 13));
  });

  test("a GitHub milestone due_on is used as stored", () => {
    const t = Date.UTC(2026, 10, 12, 9, 30);
    expect(dueInstant("github", t, "America/Los_Angeles")).toBe(t);
  });

  test("an unknown zone falls back to the next UTC midnight", () => {
    expect(dueInstant("jira", Date.parse("2026-11-12"), "Mars/Base")).toBe(Date.UTC(2026, 10, 13));
  });
});

describe("classifyDue", () => {
  const now = Date.UTC(2026, 10, 12, 10);
  const endOfToday = Date.UTC(2026, 10, 13);
  test.each([
    [now - 1, "overdue"],
    [now, "overdue"],
    [now + 1, "today"],
    [endOfToday, "today"],
    [endOfToday + 1, "later"],
  ] as const)("due %i is %s", (due, want) => {
    expect(classifyDue(due, now, endOfToday)).toBe(want);
  });

  test("the 23 h and 25 h DST days still classify by the day's own end", () => {
    // Europe/London 2026-03-29 is 23 h long: local 00:00 = 00:00Z, next local 00:00 = 23:00Z.
    const dayStart = Date.UTC(2026, 2, 29);
    const dayEnd = Date.UTC(2026, 2, 29, 23);
    expect(classifyDue(dayEnd, dayStart + 3_600_000, dayEnd)).toBe("today");
    expect(classifyDue(dayEnd + 1, dayStart, dayEnd)).toBe("later");
    // 2026-10-25 is 25 h long.
    const fallStart = Date.UTC(2026, 9, 24, 23);
    const fallEnd = Date.UTC(2026, 9, 25, 24);
    expect(classifyDue(fallEnd, fallStart, fallEnd)).toBe("today");
  });
});
