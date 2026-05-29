import { describe, expect, it } from "bun:test";
import { stripAffixChars, stripTrailingChars } from "./strip-affixes.ts";

describe("stripTrailingChars", () => {
  it("removes a maximal trailing run of the given chars", () => {
    expect(stripTrailingChars("/a/b///", "/\\")).toBe("/a/b");
    expect(stripTrailingChars("C:\\a\\b\\\\", "/\\")).toBe("C:\\a\\b");
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
