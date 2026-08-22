import { describe, expect, test } from "bun:test";

import { formatGapLine } from "./negation-output.ts";

describe("formatGapLine reports whether the pattern matched anything (F20)", () => {
  test("a zero-match pattern says the rows are UNFILTERED, not that nothing needed excluding", () => {
    // The old line for this case was `Gaps: 0 excluded (no file coverage indexed); 0 excluded
    // (file coverage truncated)` — identical to a correct pattern that legitimately excludes
    // nothing. A reader had no way to tell a clean answer from an inverted one.
    const line = formatGapLine({
      pathsMatchingGlob: 0,
      excludedNoCoverage: 0,
      excludedTruncated: 0,
    });
    expect(line).toContain("matched 0 indexed paths");
    expect(line).toContain("every row below is unfiltered");
  });

  test("a matching pattern reports the count without alarming wording", () => {
    const line = formatGapLine({
      pathsMatchingGlob: 49,
      excludedNoCoverage: 0,
      excludedTruncated: 0,
    });
    expect(line).toContain("matched 49 indexed path(s)");
    expect(line).not.toContain("unfiltered");
  });

  test("the pattern line comes FIRST, ahead of the row-exclusion counts", () => {
    // Ordering is the point: "did the filter run" has to be read before "how many rows could
    // not be verified", because it changes what those numbers mean.
    const line = formatGapLine({
      pathsMatchingGlob: 0,
      excludedNoCoverage: 7,
      excludedTruncated: 0,
    });
    expect(line.indexOf("matched 0")).toBeLessThan(line.indexOf("no file coverage indexed"));
  });

  test("a predicate with no glob is unaffected", () => {
    const line = formatGapLine({ excludedNoGraphEntity: 80 });
    expect(line).not.toContain("pattern matched");
  });
});
