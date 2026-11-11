import { describe, expect, test } from "bun:test";

import {
  isInsideWindow,
  isKnownTimeZone,
  localTimeIn,
  parseDays,
  parseMaxActions,
  parseWindow,
  parseWindowSpec,
  renderRuleText,
  StandingRuleError,
  windowLabel,
} from "./standing-rule-text.ts";

const WORK = { days: [1, 2, 3, 4, 5], from: "06:00", to: "10:00", tz: "Europe/Berlin" };

describe("limits (OR-10-6)", () => {
  test("days: default 30, 1..90 whole numbers", () => {
    expect(parseDays(undefined)).toBe(30);
    expect(parseDays(1)).toBe(1);
    expect(parseDays(90)).toBe(90);
    for (const bad of [0, 91, 1.5, "30", null, -1]) {
      expect(() => parseDays(bad)).toThrow(StandingRuleError);
    }
  });

  test("ceiling: default 100, 1..500 whole numbers", () => {
    expect(parseMaxActions(undefined)).toBe(100);
    expect(parseMaxActions(1)).toBe(1);
    expect(parseMaxActions(500)).toBe(500);
    for (const bad of [0, 501, 2.5, "9", null]) {
      expect(() => parseMaxActions(bad)).toThrow(StandingRuleError);
    }
  });
});

describe("window (OR-10-5)", () => {
  test("absent is no window; a valid one is normalised", () => {
    expect(parseWindow(undefined)).toBeUndefined();
    expect(parseWindow({ ...WORK, days: [5, 1, 3] })).toEqual({ ...WORK, days: [1, 3, 5] });
  });

  test("refuses bad shapes, days, times, overnight windows and unknown zones", () => {
    const bad: unknown[] = [
      null,
      [],
      "x",
      { ...WORK, extra: 1 },
      { ...WORK, days: [] },
      { ...WORK, days: [0] },
      { ...WORK, days: [8] },
      { ...WORK, days: [1, 1] },
      { ...WORK, days: [1.5] },
      { ...WORK, days: [1, 2, 3, 4, 5, 6, 7, 1] },
      { ...WORK, from: "6:00" },
      { ...WORK, to: "24:00" },
      { ...WORK, from: 6 },
      { ...WORK, from: "10:00", to: "06:00" },
      { ...WORK, from: "10:00", to: "10:00" },
      { ...WORK, tz: "Not/AZone" },
      { ...WORK, tz: "" },
      { ...WORK, tz: 5 },
    ];
    for (const b of bad) expect(() => parseWindow(b)).toThrow(StandingRuleError);
  });

  test("isKnownTimeZone", () => {
    expect(isKnownTimeZone("UTC")).toBe(true);
    expect(isKnownTimeZone("Europe/Berlin")).toBe(true);
    expect(isKnownTimeZone("Mars/Base")).toBe(false);
  });

  test("localTimeIn reads the weekday and minutes in the zone", () => {
    // 2026-11-11 is a Wednesday. 08:30 UTC is 09:30 in Berlin (CET, UTC+1).
    const t = Date.UTC(2026, 10, 11, 8, 30);
    expect(localTimeIn("UTC", t)).toEqual({ weekday: 3, minutes: 8 * 60 + 30 });
    expect(localTimeIn("Europe/Berlin", t)).toEqual({ weekday: 3, minutes: 9 * 60 + 30 });
    // Midnight must read 0, not 24 (h23 cycle).
    expect(localTimeIn("UTC", Date.UTC(2026, 10, 11, 0, 5))).toEqual({ weekday: 3, minutes: 5 });
  });

  test("isInsideWindow: day listed, from inclusive, to exclusive, in the window's zone", () => {
    const w = parseWindow(WORK) as NonNullable<ReturnType<typeof parseWindow>>;
    const at = (h: number, m: number, day = 11): number => Date.UTC(2026, 10, day, h - 1, m);
    expect(isInsideWindow(w, at(6, 0))).toBe(true);
    expect(isInsideWindow(w, at(9, 59))).toBe(true);
    expect(isInsideWindow(w, at(10, 0))).toBe(false);
    expect(isInsideWindow(w, at(5, 59))).toBe(false);
    // 2026-11-14 is a Saturday: not listed.
    expect(isInsideWindow(w, at(8, 0, 14))).toBe(false);
  });

  test("a throwing zone reads as outside the window", () => {
    expect(isInsideWindow({ ...WORK, tz: "Not/AZone" }, Date.now())).toBe(false);
  });

  test("windowLabel and parseWindowSpec round-trip", () => {
    expect(windowLabel(WORK)).toBe("Mon-Fri 06:00-10:00 Europe/Berlin");
    expect(windowLabel({ days: [1, 3, 6, 7], from: "09:00", to: "12:00", tz: "UTC" })).toBe(
      "Mon,Wed,Sat-Sun 09:00-12:00 UTC",
    );
    expect(parseWindowSpec("Mon-Fri 06:00-10:00 Europe/Berlin")).toEqual(WORK);
    expect(parseWindowSpec("sat,Sun 09:00-12:00 UTC").days).toEqual([6, 7]);
    for (const bad of ["", "Mon 06:00-10:00", "Fun 06:00-10:00 UTC", "Fri-Mon 06:00-10:00 UTC"]) {
      expect(() => parseWindowSpec(bad)).toThrow(StandingRuleError);
    }
  });
});

describe("renderRuleText", () => {
  const base = {
    workflowName: "weekly\u001b[31m-clean",
    workflowSha256: "ab".repeat(32),
    stepIndex: 1,
    stepLabel: "archive",
    toolId: "gmail_thread_archive",
    actionType: "gmail.thread.archive",
    scope: {
      threadId: { query: 0, column: "metadata.threadId" },
      note: { const: "line1\nline2\u001b[2J" },
    },
    window: WORK,
    expiresAt: Date.UTC(2026, 11, 11),
    maxActions: 50,
  };

  test("names the workflow, hash prefix, step, tool, every input, window, expiry and ceiling", () => {
    const lines = renderRuleText(base, Date.UTC(2026, 10, 11));
    const text = lines.join("\n");
    expect(text).toContain("(content abababababab)");
    expect(text).toContain("Step 2: archive");
    expect(text).toContain("Write: gmail_thread_archive (gmail.thread.archive)");
    expect(text).toContain("each value of column metadata.threadId that query step 1 selects");
    expect(text).toContain("the constant");
    expect(text).toContain("When: Mon-Fri 06:00-10:00 Europe/Berlin");
    expect(text).toContain("Expires: 2026-12-11T00:00:00.000Z (30 days from now)");
    expect(text).toContain("Ceiling: 50 actions");
    expect(text).toContain("not part of this rule yet");
  });

  test("stored text cannot forge a line or move the cursor", () => {
    const text = renderRuleText(base, Date.UTC(2026, 10, 11)).join("\n");
    expect(text).not.toContain("\u001b");
    // The constant's embedded newline stays inside its one line.
    const constantLine = text.split("\n").find((l) => l.includes("the constant"));
    expect(constantLine).toBeDefined();
    expect(constantLine).toContain("line1");
    expect(constantLine).toContain("line2");
  });

  test("no window reads 'any time'; a resume shows the used count", () => {
    const text = renderRuleText(
      { ...base, window: undefined, actionsUsed: 7 },
      Date.UTC(2026, 10, 11),
    );
    expect(text.join("\n")).toContain("When: any time");
    expect(text.join("\n")).toContain("Ceiling: 50 actions (7 used)");
  });
});
