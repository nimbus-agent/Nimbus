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

  test("a multi-pass item merged by a later pass is never 'cut: probe slice'", () => {
    // Primary rank 15 (outside the slice) but also matched a quoted term, so it IS in byId.
    // Its fate is decided by byId, not by the probe (spec §4.6, multi-pass reconciliation).
    expect(
      classifyCandidateOutcome({ ...base, sourceId: "a", inById: true, byIdPosition: 30 }),
    ).toBe("shown");
  });
});
