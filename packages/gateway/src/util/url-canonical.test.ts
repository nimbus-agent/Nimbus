import { describe, expect, test } from "bun:test";
import { canonicalizeUrl } from "./url-canonical.ts";

describe("canonicalizeUrl", () => {
  test("strips the fragment", () => {
    expect(canonicalizeUrl("https://e.com/a#frag")).toBe("https://e.com/a");
  });

  test("strips utm_* and known click ids but keeps other params", () => {
    expect(canonicalizeUrl("https://e.com/a?utm_source=x&q=1&fbclid=z")).toBe(
      "https://e.com/a?q=1",
    );
  });

  test("strips a trailing slash on a non-root path but preserves the root slash", () => {
    expect(canonicalizeUrl("https://e.com/a/")).toBe("https://e.com/a");
    expect(canonicalizeUrl("https://e.com/")).toBe("https://e.com/");
  });

  test("returns the input unchanged when it is not a parseable URL", () => {
    expect(canonicalizeUrl("not a url")).toBe("not a url");
  });
});
