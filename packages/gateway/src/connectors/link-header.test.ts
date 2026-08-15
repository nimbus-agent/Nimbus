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
    // It asserts GROWTH, not one wall-clock number. A single bounded check at a single
    // size is weak: a super-linear implementation can pass one 100 ms budget on a fast
    // machine and only bite in production. So each shape is timed at n and at 4n, and
    // the test fails if quadrupling the input costs more than MAX_GROWTH times as much.
    // Linear predicts 4x; quadratic predicts 16x or worse.
    //
    // Why the pattern cannot blow up: `^` gives it exactly one start position;
    // `[^<>]*` is a negated class, so on a missing `>` it gives characters back one
    // at a time, once, which is linear; and `\s*(.*)$` can never FAIL once `>` has
    // matched — `.*` with the `s` flag always reaches the end — so there is no
    // failure to backtrack into, even though `\s` and `.` overlap.
    //
    // Measured locally, 20k -> 80k: the shapes below come out at 2.80x, 3.71x, 3.33x
    // and 4.02x. A genuinely quadratic control (`\s+([.,;:])` over a whitespace run —
    // the real defect fixed in the sibling repos this pass) measured 54.97x on the same
    // harness, so the 8x threshold sits with wide margin on both sides.
    //
    // RED-PROVED, which the earlier single-fixed-bound version of this test was not:
    // splicing that quadratic into `parseLinkHeader` fails this assertion with
    // "4x the input cost 20.6x the time (12947.4ms -> 266552.0ms over 60 reps)".
    // The fixed-bound version could not be tripped at all — every quadratic edit that
    // preserved parsing stayed under its budget — which is exactly why growth, not a
    // wall-clock number, is the property worth asserting.
    const BASE = 20_000;
    const REPS = 60; // enough repetitions that the small size is measurable, not noise
    const MAX_GROWTH = 8;
    // Absorbs jitter when the baseline is a fraction of a millisecond — without it a
    // 0.1 ms baseline turns ordinary scheduler noise into a huge ratio on a loaded CI
    // runner. Large enough to be quiet, far too small to let a quadratic through: the
    // control above needed 17 000 ms at 4n against a 2 569 ms allowance.
    const SLACK_MS = 25;

    const shapes: ReadonlyArray<readonly [string, (n: number) => string]> = [
      ["unclosed <", (n) => `<${"a".repeat(n)}`],
      ["whitespace and newlines after the URL", (n) => `<u>${" \n\t".repeat(Math.floor(n / 3))}`],
      ["a long run of spaces before the params", (n) => `<u>${" ".repeat(n)}x`],
      [
        "many separators",
        (n) =>
          Array.from({ length: Math.floor(n / 20) }, (_, i) => `<u${String(i)}>; rel="next"`).join(
            ", ",
          ),
      ],
      ["nested angle brackets", (n) => `<${"<>".repeat(Math.floor(n / 2))}>`],
    ];

    const timeParse = (header: string): number => {
      parseLinkHeader(header); // warm up, so JIT compilation is not charged to the first size
      const started = performance.now();
      for (let i = 0; i < REPS; i++) parseLinkHeader(header);
      return performance.now() - started;
    };

    for (const [label, build] of shapes) {
      const small = timeParse(build(BASE));
      const large = timeParse(build(BASE * 4));
      const budget = small * MAX_GROWTH + SLACK_MS;
      expect(
        large,
        `${label}: 4x the input cost ${(large / Math.max(small, 0.01)).toFixed(1)}x the time ` +
          `(${small.toFixed(1)}ms -> ${large.toFixed(1)}ms over ${String(REPS)} reps); ` +
          `linear predicts ~4x`,
      ).toBeLessThanOrEqual(budget);
      // Keep an absolute ceiling at the largest size too: growth alone would not catch
      // a pattern that is linear but uniformly, catastrophically slow.
      expect(large, `${label} took ${large.toFixed(1)}ms for ${String(REPS)} reps`).toBeLessThan(
        1_000,
      );
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
