import { describe, expect, test } from "bun:test";

import {
  compositeSearchScore,
  normalizeBm25LowerIsBetter,
  normalizeHigherIsBetter,
  recencyScore,
  servicePriorityScore,
} from "./search-ranking.ts";

describe("search-ranking", () => {
  test("recencyScore decays with age", () => {
    const now = 1_000_000_000_000;
    expect(recencyScore(now, now)).toBe(1);
    expect(recencyScore(now - 86_400_000, now)).toBeCloseTo(0.5, 5);
  });

  test("servicePriorityScore uses map or defaults to 0.5", () => {
    const m = new Map([["github", 0.8]]);
    expect(servicePriorityScore("github", m)).toBe(0.8);
    expect(servicePriorityScore("slack", m)).toBe(0.5);
  });

  test("normalizeBm25LowerIsBetter maps lowest input to highest score", () => {
    expect(normalizeBm25LowerIsBetter([2, 4, 6])).toEqual([1, 0.5, 0]);
  });

  test("compositeSearchScore is weighted sum", () => {
    expect(compositeSearchScore(1, 1, 1)).toBe(1);
    expect(compositeSearchScore(0, 0, 0)).toBe(0);
  });

  // --- normalizeBm25LowerIsBetter uncovered branches ---

  // line 22: empty-array early return
  test("normalizeBm25LowerIsBetter returns [] for empty input", () => {
    expect(normalizeBm25LowerIsBetter([])).toEqual([]);
  });

  // line 32: non-finite values are skipped during min/max scan
  // line 41: non-finite values in the map step return 0.5
  test("normalizeBm25LowerIsBetter handles non-finite values", () => {
    // Infinity is skipped in the min/max scan (line 32 false branch),
    // then returned as 0.5 in the map step (line 41 true branch).
    // Finite values [2, 6] → min=2 max=6; 2→(6-2)/(6-2)=1, 6→0, Inf→0.5
    const result = normalizeBm25LowerIsBetter([2, Infinity, 6]);
    expect(result).toEqual([1, 0.5, 0]);
  });

  // line 37: min === max (all identical values) → all return 1
  test("normalizeBm25LowerIsBetter returns all-1 when all values are equal", () => {
    expect(normalizeBm25LowerIsBetter([5, 5, 5])).toEqual([1, 1, 1]);
  });

  // line 37: single element → min === max → returns [1]
  test("normalizeBm25LowerIsBetter returns [1] for a single-element array", () => {
    expect(normalizeBm25LowerIsBetter([42])).toEqual([1]);
  });

  // --- normalizeHigherIsBetter uncovered branches ---

  // line 53: empty-array early return
  test("normalizeHigherIsBetter returns [] for empty input", () => {
    expect(normalizeHigherIsBetter([])).toEqual([]);
  });

  // line 63: non-finite values are skipped during min/max scan
  // line 72: non-finite values in the map step return 0.5
  test("normalizeHigherIsBetter handles non-finite values", () => {
    // Finite values [2, 6] → min=2 max=6; 2→0, 6→1, -Inf→0.5
    const result = normalizeHigherIsBetter([2, -Infinity, 6]);
    expect(result).toEqual([0, 0.5, 1]);
  });

  // line 68: min === max (all identical values) → all return 1
  test("normalizeHigherIsBetter returns all-1 when all values are equal", () => {
    expect(normalizeHigherIsBetter([7, 7, 7])).toEqual([1, 1, 1]);
  });

  // line 68: single element → min === max → returns [1]
  test("normalizeHigherIsBetter returns [1] for a single-element array", () => {
    expect(normalizeHigherIsBetter([99])).toEqual([1]);
  });

  // basic happy-path for normalizeHigherIsBetter (lower→0, higher→1)
  test("normalizeHigherIsBetter maps highest input to score 1", () => {
    expect(normalizeHigherIsBetter([0, 5, 10])).toEqual([0, 0.5, 1]);
  });
});
