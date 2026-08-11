import { describe, expect, it } from "bun:test";
import { stripAffixChars, stripAffixWhere, stripTrailingChars } from "./strip-affixes.ts";

describe("stripTrailingChars", () => {
  it("removes a maximal trailing run of the given chars", () => {
    expect(stripTrailingChars("/a/b///", "/\\")).toBe("/a/b");
    expect(stripTrailingChars(String.raw`C:\a\b\\`, "/\\")).toBe(String.raw`C:\a\b`); // cross-platform-ok
    expect(stripTrailingChars("https://x/", "/")).toBe("https://x");
  });

  it("is a no-op when there is no trailing run", () => {
    expect(stripTrailingChars("/a/b", "/\\")).toBe("/a/b");
    expect(stripTrailingChars("", "/")).toBe("");
  });

  it("returns empty for an all-match input", () => {
    expect(stripTrailingChars("////", "/")).toBe("");
  });

  it("completes in linear time on a degenerate all-separator input (S5852)", () => {
    const huge = `${"/".repeat(200000)}x`;
    expect(stripTrailingChars(huge, "/\\")).toBe(huge); // no trailing separators
    expect(stripTrailingChars("/".repeat(200000), "/")).toBe("");
  });
});

describe("stripAffixChars", () => {
  it("removes leading and trailing runs but keeps interior chars", () => {
    expect(stripAffixChars("--a-b--", "-")).toBe("a-b");
    expect(stripAffixChars("-x-", "-")).toBe("x");
  });

  it("returns empty for an all-match input", () => {
    expect(stripAffixChars("----", "-")).toBe("");
    expect(stripAffixChars("", "-")).toBe("");
  });

  it("completes in linear time on a degenerate all-dash input (S5852)", () => {
    expect(stripAffixChars("-".repeat(200000), "-")).toBe("");
    const padded = `${"-".repeat(100000)}mid${"-".repeat(100000)}`;
    expect(stripAffixChars(padded, "-")).toBe("mid");
  });
});

describe("stripAffixWhere", () => {
  const isSpaceOrDash = (ch: string) => ch === "-" || /^\s$/.test(ch);

  it("trims by predicate at both ends and keeps the interior", () => {
    expect(stripAffixWhere(" -a-b- ", isSpaceOrDash)).toBe("a-b");
    expect(stripAffixWhere("abc", isSpaceOrDash)).toBe("abc");
    expect(stripAffixWhere("", isSpaceOrDash)).toBe("");
  });

  it("returns empty when the predicate matches everything", () => {
    expect(stripAffixWhere(" - - ", isSpaceOrDash)).toBe("");
  });

  it("reaches whitespace a literal char list would miss", () => {
    // NBSP, line separator, paragraph separator, ideographic space. These are
    // exactly the characters a hand-written " \t\n\r" list drops, which is why
    // the predicate form exists at all.
    expect(stripAffixWhere("  x 　", isSpaceOrDash)).toBe("x");
  });

  /**
   * The regression this whole module is shaped around, and the one a
   * correctness test cannot see: the regex spellings produce the RIGHT answer,
   * just quadratically. Only a clock catches it.
   *
   * 400k trimmable characters followed by a non-matching tail is the worst case
   * for `/[x]+$/` — every start offset scans to the end and fails. Linear code
   * finishes in single-digit milliseconds; the regex form takes minutes.
   */
  it("stays linear on a degenerate input a trailing-anchored regex would blow up on", () => {
    const hostile = `${"-".repeat(400000)}x`;
    const started = performance.now();
    expect(stripAffixWhere(hostile, isSpaceOrDash)).toBe(hostile.slice(400000));
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
