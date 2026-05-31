import { describe, expect, it } from "bun:test";

import { isoMs, maxIso } from "./sync-iso-helpers.ts";

describe("isoMs", () => {
  it("parses a valid ISO 8601 string to ms", () => {
    expect(isoMs("2024-01-01T00:00:00.000Z")).toBe(Date.parse("2024-01-01T00:00:00.000Z"));
  });

  it("returns 0 for an invalid ISO string (passthrough fallback)", () => {
    expect(isoMs("not-an-iso-date")).toBe(0);
    expect(isoMs("")).toBe(0);
  });
});

describe("maxIso", () => {
  it("returns the later of two ISO timestamps", () => {
    const earlier = "2024-01-01T00:00:00.000Z";
    const later = "2024-06-01T00:00:00.000Z";
    expect(maxIso(earlier, later)).toBe(later);
    expect(maxIso(later, earlier)).toBe(later);
  });

  it("returns the first when both parse equal (>=)", () => {
    const a = "2024-01-01T00:00:00.000Z";
    const b = "2024-01-01T00:00:00.000Z";
    expect(maxIso(a, b)).toBe(a);
  });

  it("handles invalid b as 0 — returns a even if a is also invalid", () => {
    expect(maxIso("bad-a", "bad-b")).toBe("bad-a");
    expect(maxIso("2024-01-01T00:00:00.000Z", "bad-b")).toBe("2024-01-01T00:00:00.000Z");
    expect(maxIso("bad-a", "2024-01-01T00:00:00.000Z")).toBe("2024-01-01T00:00:00.000Z");
  });
});
