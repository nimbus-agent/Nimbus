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

  test("stays linear on adversarial headers", () => {
    // SonarCloud flags LINK_VALUE_RE (`typescript:S8786`, "super-linear performance
    // due to backtracking"). It is a FALSE POSITIVE, and the issue is marked as such
    // in SonarCloud citing this test by name, so the annotation points at something
    // executable rather than at a claim in a comment.
    //
    // WHAT THIS TEST IS AND IS NOT. It is a live bound — dropping the threshold makes
    // it fail with the offending shape named, so the assertion is reached. It is NOT
    // a proven tripwire against a future backtracking edit: two attempts to introduce
    // one failed to trip it. Making the pattern quadratic the obvious way (adding a
    // failure point after the overlapping quantifiers) also changes what it parses, so
    // the CORRECTNESS tests above fire first; a lazy-body variant that does preserve
    // parsing stayed fast. Treat this as evidence for the false-positive call, not as
    // a guarantee that every future edit is caught.
    //
    // Why the pattern cannot blow up: `^` gives it exactly one start position;
    // `[^<>]*` is a negated class, so on a missing `>` it gives characters back one
    // at a time, once, which is linear; and `\s*(.*)$` can never FAIL once `>` has
    // matched — `.*` with the `s` flag always reaches the end — so there is no
    // failure to backtrack into, even though `\s` and `.` overlap.
    //
    // Measured across all five shapes below at 10k/20k/40k/80k characters: every one
    // stays at or under 0.5 ms, flat, with no growth as the input doubles. Contrast
    // a genuinely quadratic pattern, which shows 4x time for 2x input.
    const n = 40_000;
    const shapes: ReadonlyArray<readonly [string, string]> = [
      ["unclosed <", `<${"a".repeat(n)}`],
      ["whitespace and newlines after the URL", `<u>${" \n\t".repeat(n / 3)}`],
      ["a long run of spaces before the params", `<u>${" ".repeat(n)}x`],
      [
        "many separators",
        Array.from({ length: n / 20 }, (_, i) => `<u${String(i)}>; rel="next"`).join(", "),
      ],
      ["nested angle brackets", `<${"<>".repeat(n / 2)}>`],
    ];
    for (const [label, header] of shapes) {
      const started = performance.now();
      parseLinkHeader(header);
      const ms = performance.now() - started;
      expect(ms, `${label} took ${ms.toFixed(1)}ms`).toBeLessThan(100);
    }
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
