import { describe, expect, test } from "bun:test";
import { formatBytes } from "./format-bytes.ts";

describe("formatBytes", () => {
  test("bytes under 1 kB are exact, with a ' B' suffix", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(873)).toBe("873 B");
    expect(formatBytes(999)).toBe("999 B");
  });

  test("kB range: one decimal below 10, none at or above it", () => {
    expect(formatBytes(1_000)).toBe("1.0 kB");
    expect(formatBytes(9_949)).toBe("9.9 kB");
    expect(formatBytes(10_000)).toBe("10 kB");
    expect(formatBytes(999_000)).toBe("999 kB");
  });

  test("MB range: one decimal below 10, none at or above it", () => {
    expect(formatBytes(1_000_000)).toBe("1.0 MB");
    expect(formatBytes(9_949_999)).toBe("9.9 MB");
    expect(formatBytes(10_000_000)).toBe("10 MB");
  });

  test("GB range: one decimal below 10, none at or above it", () => {
    expect(formatBytes(3_900_000_000)).toBe("3.9 GB");
    expect(formatBytes(41_200_000_000)).toBe("41 GB");
  });
});
