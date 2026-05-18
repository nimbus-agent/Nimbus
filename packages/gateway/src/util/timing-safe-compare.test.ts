import { describe, expect, test } from "bun:test";
import { constantTimeStringEqual, sha256HexEqualConstantTime } from "./timing-safe-compare.ts";

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const HEX_OFF_BY_ONE = `${"a".repeat(32)}b${"a".repeat(31)}`;

// ─── sha256HexEqualConstantTime — regression-lock from hex-compare.ts ────────

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
    // 64 chars but contains a non-hex character.
    const malformed = `${"a".repeat(63)}Z`;
    expect(sha256HexEqualConstantTime(malformed, HEX_A)).toBe(false);
  });

  test("differs by a single character in the middle", () => {
    expect(sha256HexEqualConstantTime(HEX_A, HEX_OFF_BY_ONE)).toBe(false);
  });
});

// ─── constantTimeStringEqual — new canonical helper ─────────────────────────

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
    // The new canonical helper is Buffer-based (UTF-8 byte compare), which means
    // multi-byte characters are compared byte-for-byte. Locked in the T6 spec §2 PR 1
    // ("Buffer-based, with length-mismatch burn cycle to match the defensive shape
    // of `http-auth.ts`'s helper").
    expect(constantTimeStringEqual("café", "café")).toBe(true);
    expect(constantTimeStringEqual("café", "cafe")).toBe(false); // differs in content and byte length
    // Two visually distinct multi-byte strings of the same UTF-8 byte length.
    expect(constantTimeStringEqual("café", "cafè")).toBe(false);
  });

  test("returns true for typical base58 pairing-code shapes", () => {
    // Locks in compatibility for lan-pairing's existing call site (20-char base58).
    const code = "BqSv9KQwz8m3Y4r2Lh1n";
    expect(constantTimeStringEqual(code, code)).toBe(true);
    expect(constantTimeStringEqual(code, "BqSv9KQwz8m3Y4r2Lh1m")).toBe(false); // differs last char
  });

  test("returns true for typical bearer-token shapes", () => {
    // Locks in compatibility for http-auth's existing call site (long opaque token).
    const t = "n1mb_dep1oy_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect(constantTimeStringEqual(t, t)).toBe(true);
    expect(constantTimeStringEqual(t, `${t.slice(0, -1)}Z`)).toBe(false);
  });
});
