import { describe, expect, test } from "bun:test";

import { capPreview, clampLimit, formatAddress, PREVIEW_MAX_CHARS } from "../src/mail-core.ts";

describe("clampLimit", () => {
  test("defaults, floors at 1, caps at 200, truncates fractions", () => {
    expect(clampLimit(undefined)).toBe(50);
    expect(clampLimit(Number.NaN)).toBe(50);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(10_000)).toBe(200);
    expect(clampLimit(12.9)).toBe(12);
    expect(clampLimit(75)).toBe(75);
  });
});

describe("capPreview", () => {
  test("normalizes whitespace + trims and truncates", () => {
    expect(capPreview("  hi\r\n\r\n\r\nthere   you  ")).toBe("hi\nthere you");
    expect(capPreview("x".repeat(PREVIEW_MAX_CHARS + 500))).toHaveLength(PREVIEW_MAX_CHARS);
    expect(capPreview("")).toBe("");
  });
});

describe("formatAddress", () => {
  test("formats Name <addr> / bare addr / name-only / empty", () => {
    expect(formatAddress({ name: "Ada", address: "ada@proton.me" })).toBe("Ada <ada@proton.me>");
    expect(formatAddress({ address: "ada@proton.me" })).toBe("ada@proton.me");
    expect(formatAddress({ name: "Ada" })).toBe("Ada");
    expect(formatAddress({})).toBe("");
  });
});
