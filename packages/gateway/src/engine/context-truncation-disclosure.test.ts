import { describe, expect, test } from "bun:test";

import { contextTruncationLine } from "./context-truncation-disclosure.ts";

describe("contextTruncationLine (F14)", () => {
  test("names both numbers, so the reader can see the size of what is missing", () => {
    const line = contextTruncationLine({ shown: 8, total: 16, atLeast: false });
    expect(line).toContain("8");
    expect(line).toContain("16");
  });

  test("says a list is a sample, which is the claim the answer itself cannot make", () => {
    // The observed failure was a well-formed numbered list of 8 for a user with 16. Nothing in
    // that answer was wrong except its implied completeness, so completeness is what the
    // disclosure has to speak to.
    const line = contextTruncationLine({ shown: 8, total: 16, atLeast: false });
    expect(line ?? "").toMatch(/sample, not the complete set/);
  });

  test("points at the surfaces that are NOT truncated", () => {
    const line = contextTruncationLine({ shown: 8, total: 16, atLeast: false });
    expect(line).toContain("nimbus query");
    expect(line).toContain("nimbus search");
  });

  test("a floor count is marked as a floor rather than stated as exact", () => {
    // The probe has its own ceiling. Reporting its ceiling as the true total would replace one
    // confident wrong number with another.
    expect(contextTruncationLine({ shown: 8, total: 100, atLeast: true })).toContain(
      "at least 100",
    );
    expect(contextTruncationLine({ shown: 8, total: 100, atLeast: false })).not.toContain(
      "at least",
    );
  });

  test("nothing withheld yields NO line", () => {
    expect(contextTruncationLine({ shown: 8, total: 8, atLeast: false })).toBeUndefined();
    expect(contextTruncationLine({ shown: 3, total: 3, atLeast: false })).toBeUndefined();
  });

  test("a total below shown cannot produce a negative-sounding note", () => {
    // Defensive: `total` is measured by a different query than `shown` is sliced from, so they
    // can disagree. A disclosure claiming fewer matches than items shown would be nonsense.
    expect(contextTruncationLine({ shown: 8, total: 2, atLeast: false })).toBeUndefined();
  });
});
