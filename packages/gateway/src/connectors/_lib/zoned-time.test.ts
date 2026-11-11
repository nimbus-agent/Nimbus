import { describe, expect, test } from "bun:test";

import { wallToInstantMs } from "./zoned-time.ts";

const w = (y: number, mo: number, d: number, h: number, mi = 0, s = 0) => ({ y, mo, d, h, mi, s });

describe("wallToInstantMs", () => {
  test("Europe/London in summer (BST) and winter (GMT)", () => {
    expect(wallToInstantMs(w(2026, 7, 1, 9), "Europe/London")).toBe(Date.UTC(2026, 6, 1, 8));
    expect(wallToInstantMs(w(2026, 1, 15, 9), "Europe/London")).toBe(Date.UTC(2026, 0, 15, 9));
  });

  test("UTC is the identity, with seconds", () => {
    expect(wallToInstantMs(w(2026, 11, 11, 9, 30, 15), "UTC")).toBe(
      Date.UTC(2026, 10, 11, 9, 30, 15),
    );
  });

  test("a nonexistent spring-forward time resolves with the offset before the gap", () => {
    // 2026-03-08 02:30 does not exist in America/New_York (02:00 EST jumps to 03:00 EDT).
    expect(wallToInstantMs(w(2026, 3, 8, 2, 30), "America/New_York")).toBe(
      Date.UTC(2026, 2, 8, 7, 30),
    );
  });

  test("the repeated fall-back hour resolves to the first occurrence", () => {
    // 2026-11-01 01:30 happens twice in America/New_York; the first is EDT (UTC-4).
    expect(wallToInstantMs(w(2026, 11, 1, 1, 30), "America/New_York")).toBe(
      Date.UTC(2026, 10, 1, 5, 30),
    );
  });

  test("a zone east of UTC with a half-hour offset", () => {
    expect(wallToInstantMs(w(2026, 11, 11, 9), "Asia/Kolkata")).toBe(Date.UTC(2026, 10, 11, 3, 30));
  });

  test("an instant before 1970 (negative epoch ms) resolves", () => {
    expect(wallToInstantMs(w(1965, 6, 1, 12, 0, 30), "Europe/London")).toBe(
      Date.UTC(1965, 5, 1, 11, 0, 30),
    );
  });

  test("an unknown zone is undefined, and so is an impossible date", () => {
    expect(wallToInstantMs(w(2026, 11, 11, 9), "Not/AZone")).toBeUndefined();
    expect(wallToInstantMs(w(Number.NaN, 1, 1, 0), "UTC")).toBeUndefined();
  });
});
