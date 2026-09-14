import { describe, expect, test } from "bun:test";
import { classifyCandidateOutcome } from "./ask-explain-outcome.ts";

const shown = new Set(["a", "b"]);
const base = { shownIds: shown, limit: 8 } as const;

describe("classifyCandidateOutcome (spec §4.6)", () => {
  test("an item in the final selection is shown", () => {
    expect(
      classifyCandidateOutcome({ ...base, sourceId: "a", inById: true, byIdPosition: 0 }),
    ).toBe("shown");
  });

  test("an item that never entered byId was cut by the probe slice", () => {
    // This is the LARGEST discard: the primary probe fetches 100 and only the top 8 are merged.
    expect(
      classifyCandidateOutcome({ ...base, sourceId: "z", inById: false, byIdPosition: -1 }),
    ).toBe("cut: probe slice");
  });

  test("an item inside the budget by arrival order but not selected was displaced by fairness", () => {
    expect(
      classifyCandidateOutcome({ ...base, sourceId: "c", inById: true, byIdPosition: 2 }),
    ).toBe("cut: service fairness");
  });

  test("an item beyond the budget by arrival order was cut by the cap", () => {
    expect(
      classifyCandidateOutcome({ ...base, sourceId: "d", inById: true, byIdPosition: 20 }),
    ).toBe("cut: over cap");
  });

  test("an item at position limit-1 is still inside the budget by arrival order", () => {
    // Boundary test: byIdPosition: 7 with limit: 8 (7 < 8 is true)
    expect(
      classifyCandidateOutcome({ ...base, sourceId: "x", inById: true, byIdPosition: 7 }),
    ).toBe("cut: service fairness");
  });

  test("an item at position exactly limit crosses into over cap", () => {
    // Boundary test: byIdPosition: 8 with limit: 8 (8 < 8 is false)
    expect(
      classifyCandidateOutcome({ ...base, sourceId: "y", inById: true, byIdPosition: 8 }),
    ).toBe("cut: over cap");
  });
});
