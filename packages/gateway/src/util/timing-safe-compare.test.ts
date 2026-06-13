import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { constantTimeStringEqual, sha256HexEqualConstantTime } from "./timing-safe-compare.ts";

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const HEX_OFF_BY_ONE = `${"a".repeat(32)}b${"a".repeat(31)}`;

describe("sha256HexEqualConstantTime", () => {
  test("returns true for equal 64-char hex", () => {
    expect(sha256HexEqualConstantTime(HEX_A, HEX_A)).toBe(true);
  });

  test("returns false for unequal hex of equal length", () => {
    expect(sha256HexEqualConstantTime(HEX_A, HEX_B)).toBe(false);
  });

  test("returns false when first input is not 64 chars", () => {
    const short = "a".repeat(63);
    expect(sha256HexEqualConstantTime(short, HEX_A)).toBe(false);
  });

  test("returns false when second input is not 64 chars", () => {
    const short = "a".repeat(63);
    expect(sha256HexEqualConstantTime(HEX_A, short)).toBe(false);
  });

  test("returns false when both inputs are empty", () => {
    expect(sha256HexEqualConstantTime("", "")).toBe(false);
  });

  test("returns false for malformed hex (non-hex chars)", () => {
    const malformed = `${"a".repeat(63)}Z`;
    expect(sha256HexEqualConstantTime(malformed, HEX_A)).toBe(false);
  });

  test("differs by a single character in the middle", () => {
    expect(sha256HexEqualConstantTime(HEX_A, HEX_OFF_BY_ONE)).toBe(false);
  });
});

describe("constantTimeStringEqual", () => {
  test("returns true for equal strings", () => {
    expect(constantTimeStringEqual("hello", "hello")).toBe(true);
  });

  test("returns false for different strings of same length", () => {
    expect(constantTimeStringEqual("hello", "world")).toBe(false);
  });

  test("returns false for different lengths", () => {
    expect(constantTimeStringEqual("abc", "abcd")).toBe(false);
    expect(constantTimeStringEqual("abcd", "abc")).toBe(false);
  });

  test("returns true for two empty strings", () => {
    expect(constantTimeStringEqual("", "")).toBe(true);
  });

  test("returns false when only one input is empty", () => {
    expect(constantTimeStringEqual("", "x")).toBe(false);
    expect(constantTimeStringEqual("x", "")).toBe(false);
  });

  test("handles UTF-8 multi-byte characters correctly", () => {
    expect(constantTimeStringEqual("café", "café")).toBe(true);
    expect(constantTimeStringEqual("café", "cafe")).toBe(false);
    expect(constantTimeStringEqual("café", "cafè")).toBe(false);
  });

  test("returns true for typical base58 pairing-code shapes", () => {
    const code = "BqSv9KQwz8m3Y4r2Lh1n";
    expect(constantTimeStringEqual(code, code)).toBe(true);
    expect(constantTimeStringEqual(code, "BqSv9KQwz8m3Y4r2Lh1m")).toBe(false);
  });

  test("returns true for typical bearer-token shapes", () => {
    const t = "n1mb_dep1oy_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect(constantTimeStringEqual(t, t)).toBe(true);
    expect(constantTimeStringEqual(t, `${t.slice(0, -1)}Z`)).toBe(false);
  });
});

describe("timing-safe-compare — properties (fast-check)", () => {
  // constantTimeStringEqual must agree with `===` for EVERY pair of JS strings,
  // including ill-formed ones (lone surrogates). `unit: "binary"` generates the
  // full 16-bit code-unit range, including lone surrogates.
  const anyString = fc.string({ unit: "binary" });

  test("constantTimeStringEqual(a, b) === (a === b) over arbitrary strings", () => {
    fc.assert(
      fc.property(anyString, anyString, (a, b) => {
        expect(constantTimeStringEqual(a, b)).toBe(a === b);
      }),
      { numRuns: 1000 },
    );
  });

  test("constantTimeStringEqual is reflexive over arbitrary strings", () => {
    fc.assert(
      fc.property(anyString, (a) => {
        expect(constantTimeStringEqual(a, a)).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  test("constantTimeStringEqual distinguishes distinct lone surrogates (regression)", () => {
    // Two DIFFERENT lone surrogates both UTF-8-encode to the replacement bytes
    // EF BF BD; a utf8 buffer compare collides and falsely returns true.
    expect(constantTimeStringEqual("\uD800", "\uDC00")).toBe(false);
    expect(constantTimeStringEqual("�", "\uD800")).toBe(false);
  });

  // sha256HexEqualConstantTime compares the DECODED bytes (hex is case-insensitive),
  // not the strings.
  const hex64 = fc
    .array(fc.constantFrom(..."0123456789abcdefABCDEF".split("")), { minLength: 64, maxLength: 64 })
    .map((a) => a.join(""));

  test("sha256HexEqualConstantTime === decoded-byte equality for valid 64-hex", () => {
    fc.assert(
      fc.property(hex64, hex64, (a, b) => {
        const expected = Buffer.from(a, "hex").equals(Buffer.from(b, "hex"));
        expect(sha256HexEqualConstantTime(a, b)).toBe(expected);
      }),
      { numRuns: 500 },
    );
  });

  test("sha256HexEqualConstantTime reflexive + case-insensitive for valid 64-hex", () => {
    fc.assert(
      fc.property(hex64, (a) => {
        expect(sha256HexEqualConstantTime(a, a)).toBe(true);
        expect(sha256HexEqualConstantTime(a.toLowerCase(), a.toUpperCase())).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  test("sha256HexEqualConstantTime is false for a 64-char string with any non-hex char", () => {
    const nonHex = fc.constantFrom(..."ghijklmnopqrstuvwxyzGHIJKLMNOPQRSTUVWXYZ!@ _-".split(""));
    fc.assert(
      fc.property(hex64, fc.integer({ min: 0, max: 63 }), nonHex, (h, pos, bad) => {
        const corrupted = h.slice(0, pos) + bad + h.slice(pos + 1);
        expect(sha256HexEqualConstantTime(corrupted, h)).toBe(false);
      }),
      { numRuns: 500 },
    );
  });
});
