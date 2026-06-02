import { describe, expect, test } from "bun:test";

import { capPreview, clampLimit, formatAddress, PREVIEW_MAX_CHARS } from "../src/imap-core.ts";

describe("clampLimit", () => {
  test("returns the default for undefined / non-finite", () => {
    expect(clampLimit(undefined)).toBe(50);
    expect(clampLimit(Number.NaN)).toBe(50);
    expect(clampLimit(undefined, 25)).toBe(25);
  });

  test("floors at 1 and caps at 200", () => {
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-5)).toBe(1);
    expect(clampLimit(10_000)).toBe(200);
  });

  test("truncates a fractional limit", () => {
    expect(clampLimit(12.9)).toBe(12);
  });

  test("passes a valid in-range value through", () => {
    expect(clampLimit(75)).toBe(75);
  });
});

describe("capPreview", () => {
  test("normalizes CRLF, collapses whitespace and blank-line runs, trims", () => {
    expect(capPreview("  hi\r\n\r\n\r\nthere   you  ")).toBe("hi\nthere you");
  });

  test("truncates to PREVIEW_MAX_CHARS", () => {
    const out = capPreview("x".repeat(PREVIEW_MAX_CHARS + 500));
    expect(out.length).toBe(PREVIEW_MAX_CHARS);
  });

  test("returns an empty string unchanged", () => {
    expect(capPreview("")).toBe("");
  });
});

describe("formatAddress", () => {
  test("formats 'Name <addr>' when both present", () => {
    expect(formatAddress({ name: "Ada", address: "ada@x.com" })).toBe("Ada <ada@x.com>");
  });

  test("returns the bare address when no name", () => {
    expect(formatAddress({ address: "ada@x.com" })).toBe("ada@x.com");
  });

  test("returns the name when no address", () => {
    expect(formatAddress({ name: "Ada" })).toBe("Ada");
  });

  test("returns an empty string when neither present", () => {
    expect(formatAddress({})).toBe("");
  });
});
