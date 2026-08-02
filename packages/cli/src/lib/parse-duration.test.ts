import { describe, expect, test } from "bun:test";

import { parseDurationToMs } from "./parse-duration.ts";

describe("parseDurationToMs", () => {
  test("parses common units", () => {
    expect(parseDurationToMs("500ms")).toBe(500);
    expect(parseDurationToMs("30s")).toBe(30_000);
    expect(parseDurationToMs("5m")).toBe(300_000);
    expect(parseDurationToMs("2h")).toBe(2 * 60 * 60 * 1000);
  });

  test("rejects invalid input", () => {
    expect(() => parseDurationToMs("")).toThrow(/Invalid duration/);
    expect(() => parseDurationToMs("5x")).toThrow(/Invalid duration/);
  });

  test("parses zero value for each unit", () => {
    expect(parseDurationToMs("0ms")).toBe(0);
    expect(parseDurationToMs("0s")).toBe(0);
    expect(parseDurationToMs("0m")).toBe(0);
    expect(parseDurationToMs("0h")).toBe(0);
  });

  test("trims leading and trailing whitespace", () => {
    expect(parseDurationToMs("  10s  ")).toBe(10_000);
    expect(parseDurationToMs("\t5m\t")).toBe(300_000);
  });

  test("parses units case-insensitively", () => {
    expect(parseDurationToMs("500MS")).toBe(500);
    expect(parseDurationToMs("30S")).toBe(30_000);
    expect(parseDurationToMs("5M")).toBe(300_000);
    expect(parseDurationToMs("2H")).toBe(2 * 60 * 60 * 1000);
    // mixed case
    expect(parseDurationToMs("100Ms")).toBe(100);
  });

  test("accepts optional whitespace between number and unit", () => {
    // the regex allows \s* between digits and unit
    expect(parseDurationToMs("10 s")).toBe(10_000);
    expect(parseDurationToMs("3 m")).toBe(3 * 60 * 1000);
  });

  test("floors fractional milliseconds", () => {
    // ms unit: Math.floor(n) — fractional digits would be stripped by regex,
    // so any digit-only match is an integer; floor has no visible effect here
    expect(parseDurationToMs("1ms")).toBe(1);
    expect(parseDurationToMs("1s")).toBe(1_000);
    expect(parseDurationToMs("1m")).toBe(60_000);
    expect(parseDurationToMs("1h")).toBe(3_600_000);
  });

  test("rejects formats that look numeric but have no unit", () => {
    expect(() => parseDurationToMs("100")).toThrow(/Invalid duration "100"/);
  });

  test("rejects negative-looking input (sign char outside digit range)", () => {
    // A leading '-' is not matched by \d+ so the regex rejects it
    expect(() => parseDurationToMs("-5s")).toThrow(/Invalid duration/);
  });

  test("accepts day and week units", () => {
    expect(parseDurationToMs("90d")).toBe(90 * 24 * 60 * 60 * 1000);
    expect(parseDurationToMs("2w")).toBe(2 * 7 * 24 * 60 * 60 * 1000);
  });

  test("still rejects an unknown unit", () => {
    expect(() => parseDurationToMs("90x")).toThrow();
  });

  test("pre-existing units are unchanged", () => {
    expect(parseDurationToMs("30s")).toBe(30_000);
    expect(parseDurationToMs("5m")).toBe(300_000);
    expect(parseDurationToMs("1h")).toBe(3_600_000);
    expect(parseDurationToMs("250ms")).toBe(250);
  });

  test("rejects input with only whitespace", () => {
    expect(() => parseDurationToMs("   ")).toThrow(/Invalid duration/);
  });

  test("rejects input with decimal point (regex requires \\d+)", () => {
    expect(() => parseDurationToMs("1.5s")).toThrow(/Invalid duration/);
    expect(() => parseDurationToMs("0.5m")).toThrow(/Invalid duration/);
  });

  test("exact ms values for large numbers", () => {
    expect(parseDurationToMs("1000ms")).toBe(1_000);
    expect(parseDurationToMs("60s")).toBe(60_000);
    expect(parseDurationToMs("60m")).toBe(3_600_000);
    expect(parseDurationToMs("24h")).toBe(86_400_000);
  });

  test("rejects an overflowing magnitude that parses to Infinity (non-finite guard)", () => {
    // A 320-digit magnitude still matches /^(\d+)\s*(ms|s|m|h)$/, so the regex check passes —
    // but Number(...) === Infinity, which exercises the !Number.isFinite(n) arm. That throw is
    // distinct from the regex-mismatch throw (it omits the "use e.g." suffix), so asserting the
    // exact message proves the non-finite branch ran rather than the format-reject branch.
    const huge = `${"9".repeat(320)}s`;
    expect(Number(huge.slice(0, -1))).toBe(Number.POSITIVE_INFINITY);
    let message = "";
    try {
      parseDurationToMs(huge);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toBe(`Invalid duration "${huge}"`);
    expect(message).not.toContain("use e.g.");
  });
});
