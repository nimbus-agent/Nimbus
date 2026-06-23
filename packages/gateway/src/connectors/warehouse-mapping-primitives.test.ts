import { describe, expect, test } from "bun:test";
import {
  BODY_MAX,
  clamp,
  epochToMs,
  parseTimestampMs,
  TITLE_MAX,
} from "./warehouse-mapping-primitives.ts";

describe("warehouse-mapping-primitives", () => {
  test("clamp constants are the shared title/body limits", () => {
    expect(TITLE_MAX).toBe(256);
    expect(BODY_MAX).toBe(512);
  });

  test("epochToMs treats < 1e12 as seconds and larger as millis", () => {
    expect(epochToMs(1_700_000_000)).toBe(1_700_000_000_000);
    expect(epochToMs(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(epochToMs(1_700_000_000.5)).toBe(1_700_000_000_500);
  });

  describe("parseTimestampMs", () => {
    test("finite epoch number (seconds) → millis", () => {
      expect(parseTimestampMs(1_700_000_000)).toBe(1_700_000_000_000);
    });

    test("finite epoch number already in millis → unchanged", () => {
      expect(parseTimestampMs(1_700_000_000_000)).toBe(1_700_000_000_000);
    });

    test("non-finite number → null", () => {
      expect(parseTimestampMs(Number.NaN)).toBeNull();
      expect(parseTimestampMs(Number.POSITIVE_INFINITY)).toBeNull();
    });

    test("bare numeric string → parsed as epoch", () => {
      expect(parseTimestampMs("1700000000")).toBe(1_700_000_000_000);
      expect(parseTimestampMs("1700000000.25")).toBe(1_700_000_000_250);
    });

    test("ISO-8601 string → Date.parse millis", () => {
      expect(parseTimestampMs("2023-11-14T22:13:20.000Z")).toBe(
        Date.parse("2023-11-14T22:13:20.000Z"),
      );
    });

    test("unparseable string → null", () => {
      expect(parseTimestampMs("not-a-date")).toBeNull();
    });

    test("empty / whitespace-only string → null", () => {
      expect(parseTimestampMs("")).toBeNull();
      expect(parseTimestampMs("   ")).toBeNull();
    });

    test("non-string, non-number input → null", () => {
      expect(parseTimestampMs(undefined)).toBeNull();
      expect(parseTimestampMs(null)).toBeNull();
      expect(parseTimestampMs({})).toBeNull();
    });
  });

  describe("clamp", () => {
    test("returns the string unchanged when within the limit", () => {
      expect(clamp("short", 10)).toBe("short");
      expect(clamp("exactly-10", 10)).toBe("exactly-10");
    });

    test("truncates and appends an ellipsis when over the limit", () => {
      expect(clamp("abcdef", 3)).toBe("abc…");
    });
  });
});
