import { describe, expect, test } from "bun:test";

import {
  combinePointInTimeFacts,
  POINT_IN_TIME_TOOL_IDS,
  POINT_IN_TIME_WITHHELD_TOOL_IDS,
  pointInTimeInstruction,
} from "./point-in-time.ts";

describe("combinePointInTimeFacts", () => {
  test("with no search: zero gaps and the fallback history start", () => {
    expect(combinePointInTimeFacts(5, [], 9)).toEqual({ atMs: 5, historyStartMs: 9, gapCount: 0 });
    expect(combinePointInTimeFacts(5, [], null)).toEqual({
      atMs: 5,
      historyStartMs: null,
      gapCount: 0,
    });
  });

  test("the LATEST history start and the largest gap count win", () => {
    expect(
      combinePointInTimeFacts(
        5,
        [
          { atMs: 5, historyStartMs: 10, gapCount: 2 },
          { atMs: 5, historyStartMs: 30, gapCount: 1 },
          { atMs: 5, historyStartMs: null, gapCount: 7 },
          { atMs: 5, historyStartMs: 20, gapCount: 0 },
        ],
        1,
      ),
    ).toEqual({ atMs: 5, historyStartMs: 30, gapCount: 7 });
  });

  test("when every search had empty history the start stays null", () => {
    expect(
      combinePointInTimeFacts(5, [{ atMs: 5, historyStartMs: null, gapCount: 0 }], 99)
        .historyStartMs,
    ).toBeNull();
  });
});

describe("point-in-time tool lists and instruction", () => {
  test("the offered and withheld lists are disjoint", () => {
    for (const id of POINT_IN_TIME_TOOL_IDS)
      expect(POINT_IN_TIME_WITHHELD_TOOL_IDS).not.toContain(id);
  });

  test("the instruction names the instant and says titles and bodies are as of now", () => {
    const s = pointInTimeInstruction(Date.UTC(2026, 10, 11, 9));
    expect(s).toContain("2026-11-11T09:00:00.000Z");
    expect(s).toContain("titles and bodies are as of now");
  });
});
