import { describe, expect, it } from "bun:test";

import { stripTrailingSlashes } from "./strip-trailing-slashes.ts";

describe("stripTrailingSlashes", () => {
  it("returns the input unchanged when it has no trailing slash", () => {
    expect(stripTrailingSlashes("foo")).toBe("foo");
    expect(stripTrailingSlashes("/foo/bar")).toBe("/foo/bar");
  });

  it("strips a single trailing slash", () => {
    expect(stripTrailingSlashes("foo/")).toBe("foo");
  });

  it("strips multiple trailing slashes", () => {
    expect(stripTrailingSlashes("foo///")).toBe("foo");
  });

  it("trims surrounding whitespace before stripping", () => {
    expect(stripTrailingSlashes("  foo/  ")).toBe("foo");
    expect(stripTrailingSlashes("\tfoo//\n")).toBe("foo");
  });

  it("returns an empty string when the input is whitespace + only-slashes", () => {
    expect(stripTrailingSlashes("///")).toBe("");
    expect(stripTrailingSlashes("   ///   ")).toBe("");
  });

  it("returns an empty string when the input is empty or whitespace", () => {
    expect(stripTrailingSlashes("")).toBe("");
    expect(stripTrailingSlashes("   ")).toBe("");
  });

  it("does not touch a leading slash", () => {
    expect(stripTrailingSlashes("/foo")).toBe("/foo");
    expect(stripTrailingSlashes("/")).toBe("");
  });
});
