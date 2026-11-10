import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatCount,
  formatMs,
  formatPercent,
  formatRelative,
} from "../../../src/components/dashboard/format";

describe("format", () => {
  it("formats counts with thousand separators", () => {
    expect(formatCount(124_387)).toBe("124,387");
    expect(formatCount(0)).toBe("0");
  });
  it("formats percent with zero decimals for integers", () => {
    expect(formatPercent(83)).toBe("83%");
    expect(formatPercent(83.4)).toBe("83%");
    expect(formatPercent(100)).toBe("100%");
  });
  it("formats ms with unit", () => {
    expect(formatMs(42)).toBe("42 ms");
    expect(formatMs(1_245)).toBe("1,245 ms");
  });
  it("formats bytes to human units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(2_147_483_648)).toBe("2.0 GB");
  });
  it("formats relative time", () => {
    const now = Date.now();
    expect(formatRelative(new Date(now - 1_000).toISOString(), now)).toMatch(/just now|1 s ago/);
    expect(formatRelative(new Date(now - 120_000).toISOString(), now)).toBe("2 m ago");
    expect(formatRelative(new Date(now - 3_600_000).toISOString(), now)).toBe("1 h ago");
  });
});

describe("format edge cases", () => {
  it("rolls bytes through every unit and stops at TB", () => {
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(5 * 1024 ** 2)).toBe("5.0 MB");
    expect(formatBytes(3 * 1024 ** 4)).toBe("3.0 TB");
    expect(formatBytes(2048 * 1024 ** 4)).toBe("2048.0 TB");
  });
  it("relative time covers seconds, days, a bad date and a future date", () => {
    const now = 10_000_000_000;
    expect(formatRelative(new Date(now - 30_000).toISOString(), now)).toBe("30 s ago");
    expect(formatRelative(new Date(now - 3 * 86_400_000).toISOString(), now)).toBe("3 d ago");
    expect(formatRelative("not a date", now)).toBe("—");
    expect(formatRelative(new Date(now + 60_000).toISOString(), now)).toBe("just now");
  });
});
