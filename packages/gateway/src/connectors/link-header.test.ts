import { describe, expect, test } from "bun:test";

import { nextPageUrl, parseLinkHeader } from "./link-header.ts";

describe("parseLinkHeader", () => {
  test("returns [] for null, empty and whitespace headers", () => {
    expect(parseLinkHeader(null)).toEqual([]);
    expect(parseLinkHeader("")).toEqual([]);
    expect(parseLinkHeader("   ")).toEqual([]);
  });

  test("parses url and params of a single link-value", () => {
    const [link] = parseLinkHeader('<https://api/x?cursor=0:100:0>; rel="next"; results="true"');
    expect(link?.url).toBe("https://api/x?cursor=0:100:0");
    expect(link?.params["rel"]).toBe("next");
    expect(link?.params["results"]).toBe("true");
  });

  test("splits multiple link-values", () => {
    const links = parseLinkHeader('<https://api/p>; rel="previous", <https://api/n>; rel="next"');
    expect(links.map((l) => l.url)).toEqual(["https://api/p", "https://api/n"]);
  });

  test("does not split on a comma inside the URL", () => {
    const links = parseLinkHeader('<https://api/x?ids=1,2,3>; rel="next"');
    expect(links).toHaveLength(1);
    expect(links[0]?.url).toBe("https://api/x?ids=1,2,3");
  });

  test("accepts unquoted param values and mixed case keys", () => {
    const [link] = parseLinkHeader("<https://api/n>; REL=next; Results=False");
    expect(link?.params["rel"]).toBe("next");
    expect(link?.params["results"]).toBe("False");
  });

  test("skips malformed link-values instead of throwing", () => {
    expect(parseLinkHeader("not-a-link")).toEqual([]);
    expect(parseLinkHeader('garbage, <https://api/n>; rel="next"')).toHaveLength(1);
  });

  test("a link-value with no params yields an empty param map", () => {
    const [link] = parseLinkHeader("<https://api/n>");
    expect(link?.url).toBe("https://api/n");
    expect(link?.params).toEqual({});
  });
});

describe("nextPageUrl", () => {
  test("returns the next URL when results is true", () => {
    expect(nextPageUrl('<https://api/n>; rel="next"; results="true"')).toBe("https://api/n");
  });

  // THE SENTRY TERMINATION GUARD. Sentry always emits rel="next".
  test("returns null when the next link declares results=false", () => {
    expect(nextPageUrl('<https://api/n>; rel="next"; results="false"')).toBeNull();
  });

  // THE ORDER-INDEPENDENCE GUARD. The regex this module replaces required rel to come first.
  test("finds rel=next regardless of parameter order", () => {
    expect(nextPageUrl('<https://api/n>; results="true"; cursor="0:100:0"; rel="next"')).toBe(
      "https://api/n",
    );
    expect(nextPageUrl('<https://api/n>; results="false"; rel="next"')).toBeNull();
  });

  test("treats an absent results attribute as true (RFC-5988 compatibility)", () => {
    expect(nextPageUrl('<https://api/n>; rel="next"')).toBe("https://api/n");
  });

  test("ignores non-next relations", () => {
    expect(nextPageUrl('<https://api/p>; rel="previous"; results="true"')).toBeNull();
  });

  test("picks next out of a multi-link header", () => {
    const header =
      '<https://api/p>; rel="previous"; results="false", <https://api/n>; rel="next"; results="true"';
    expect(nextPageUrl(header)).toBe("https://api/n");
  });

  test("returns null for null, empty, and an empty URL", () => {
    expect(nextPageUrl(null)).toBeNull();
    expect(nextPageUrl("")).toBeNull();
    expect(nextPageUrl('<>; rel="next"')).toBeNull();
  });
});
