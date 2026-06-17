import { describe, expect, test } from "bun:test";
import { clamp, parseDateMs } from "./email-mapping.ts";

describe("clamp", () => {
  test("string under max is returned unchanged", () => {
    expect(clamp("hello", 10)).toBe("hello");
  });

  test("string exactly at max is returned unchanged", () => {
    expect(clamp("hello", 5)).toBe("hello");
  });

  test("string over max is truncated and appended with ellipsis", () => {
    const result = clamp("hello world", 5);
    expect(result).toBe("hello…");
  });

  test("empty string under max is returned unchanged", () => {
    expect(clamp("", 10)).toBe("");
  });
});

describe("parseDateMs", () => {
  test("finite number is returned as-is", () => {
    expect(parseDateMs(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  test("zero is returned as-is (finite)", () => {
    expect(parseDateMs(0)).toBe(0);
  });

  test("ISO string is parsed to milliseconds", () => {
    const ms = Date.parse("2023-11-14T22:13:20.000Z");
    expect(parseDateMs("2023-11-14T22:13:20.000Z")).toBe(ms);
  });

  test("parseable date string returns milliseconds", () => {
    const ms = Date.parse("2023-01-01");
    expect(parseDateMs("2023-01-01")).toBe(ms);
  });

  test("null returns null", () => {
    expect(parseDateMs(null)).toBeNull();
  });

  test("empty string returns null", () => {
    expect(parseDateMs("")).toBeNull();
  });

  test("whitespace-only string returns null", () => {
    expect(parseDateMs("   ")).toBeNull();
  });

  test("invalid string returns null", () => {
    expect(parseDateMs("not-a-date")).toBeNull();
  });

  test("NaN number returns null", () => {
    expect(parseDateMs(Number.NaN)).toBeNull();
  });

  test("Infinity returns null", () => {
    expect(parseDateMs(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
