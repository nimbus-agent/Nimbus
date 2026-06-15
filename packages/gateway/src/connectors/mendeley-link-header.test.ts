import { describe, expect, test } from "bun:test";
import { parseNextLink } from "./mendeley-link-header.ts";

describe("parseNextLink", () => {
  test("extracts the rel=next URL", () => {
    expect(parseNextLink('<https://api.mendeley.com/documents?marker=AAA>; rel="next"')).toBe(
      "https://api.mendeley.com/documents?marker=AAA",
    );
  });

  test("picks next out of multiple links and tolerates whitespace/casing", () => {
    const h =
      '<https://api.mendeley.com/documents?marker=B>;   REL="next" , <https://api.mendeley.com/documents?marker=A>; rel="last"';
    expect(parseNextLink(h)).toBe("https://api.mendeley.com/documents?marker=B");
  });

  test("returns null when there is no next link", () => {
    expect(parseNextLink('<https://api.mendeley.com/documents?marker=Z>; rel="last"')).toBeNull();
    expect(parseNextLink("")).toBeNull();
    expect(parseNextLink(null)).toBeNull();
  });

  test("handles malformed segments and picks next when present alongside invalid", () => {
    const h = 'invalid-segment, <https://api.mendeley.com/documents?marker=C>; rel="next"';
    expect(parseNextLink(h)).toBe("https://api.mendeley.com/documents?marker=C");
  });
});
