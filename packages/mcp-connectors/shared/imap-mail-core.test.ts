import { describe, expect, test } from "bun:test";
import {
  capPreview,
  clampLimit,
  formatAddress,
  PREVIEW_FETCH_BYTES,
  PREVIEW_MAX_CHARS,
} from "./imap-mail-core.ts";

const LF = String.fromCharCode(0x0a);
const CRLF = String.fromCharCode(0x0d, 0x0a);
const TAB = String.fromCharCode(0x09);

/**
 * These helpers are shared by the imap and protonmail connectors and decide how
 * much of a message body is ever indexed or returned. The file had no test of
 * its own — its 50% line / 29% branch came incidentally from imap-tool-kit's
 * tests loading it — so the clamping and capping rules that bound what leaves a
 * mailbox were asserted nowhere.
 */
describe("clampLimit", () => {
  test("passes a sane limit through untouched", () => {
    expect(clampLimit(25)).toBe(25);
  });

  test("falls back when undefined", () => {
    expect(clampLimit(undefined)).toBe(50);
  });

  test("honours a caller-supplied fallback", () => {
    expect(clampLimit(undefined, 10)).toBe(10);
  });

  test("rejects non-finite input by falling back, rather than propagating NaN", () => {
    // The direction that matters: NaN reaching a FETCH range is unbounded.
    expect(clampLimit(Number.NaN)).toBe(50);
    expect(clampLimit(Number.POSITIVE_INFINITY)).toBe(50);
    expect(clampLimit(Number.NEGATIVE_INFINITY)).toBe(50);
  });

  test("floors to 1 for zero and negatives", () => {
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-5)).toBe(1);
  });

  test("caps at 200", () => {
    expect(clampLimit(201)).toBe(200);
    expect(clampLimit(1_000_000)).toBe(200);
    expect(clampLimit(200)).toBe(200);
  });

  test("truncates a fractional limit rather than rounding up", () => {
    expect(clampLimit(2.9)).toBe(2);
    expect(clampLimit(0.9)).toBe(1); // trunc -> 0, then floored to 1
  });
});

describe("capPreview", () => {
  test("normalises CRLF to LF", () => {
    expect(capPreview(`a${CRLF}b`)).toBe(`a${LF}b`);
  });

  test("collapses runs of spaces and tabs", () => {
    expect(capPreview(`a   b${TAB}${TAB}c`)).toBe("a b c");
  });

  test("collapses blank-line runs to a single newline", () => {
    expect(capPreview(`a${LF}${LF}${LF}b`)).toBe(`a${LF}b`);
  });

  test("trims surrounding whitespace", () => {
    expect(capPreview("   hello   ")).toBe("hello");
  });

  test("truncates at PREVIEW_MAX_CHARS", () => {
    const out = capPreview("x".repeat(PREVIEW_MAX_CHARS + 500));
    expect(out).toHaveLength(PREVIEW_MAX_CHARS);
  });

  test("leaves input at exactly the cap untouched", () => {
    const exact = "y".repeat(PREVIEW_MAX_CHARS);
    expect(capPreview(exact)).toHaveLength(PREVIEW_MAX_CHARS);
  });

  // The docblock promises it "never lengthens the input" — that is the property
  // a preview cap must not violate, so assert it rather than trusting the prose.
  test("never lengthens the input", () => {
    for (const s of ["", "a", `a${CRLF}b`, `  a${TAB}b  `, "z".repeat(5000)]) {
      expect(capPreview(s).length).toBeLessThanOrEqual(s.length);
    }
  });

  test("an empty body stays empty", () => {
    expect(capPreview("")).toBe("");
  });
});

describe("formatAddress", () => {
  test("renders name and address together", () => {
    expect(formatAddress({ name: "Ada", address: "ada@example.com" })).toBe(
      "Ada <ada@example.com>",
    );
  });

  test("renders a bare address when there is no name", () => {
    expect(formatAddress({ address: "ada@example.com" })).toBe("ada@example.com");
  });

  test("treats an empty name as no name", () => {
    expect(formatAddress({ name: "", address: "ada@example.com" })).toBe("ada@example.com");
  });

  test("falls back to the name alone when the address is missing", () => {
    expect(formatAddress({ name: "Ada" })).toBe("Ada");
  });

  test("yields an empty string when the address is absent entirely", () => {
    expect(formatAddress({})).toBe("");
  });
});

describe("preview constants", () => {
  test("are the documented bounds", () => {
    expect(PREVIEW_MAX_CHARS).toBe(2000);
    expect(PREVIEW_FETCH_BYTES).toBe(2048);
  });
});
