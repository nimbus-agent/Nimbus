import { describe, expect, test } from "bun:test";
import { median } from "./median.ts";

describe("median", () => {
  test("an empty input is unmeasurable, not zero", () => {
    // The distinction the whole pre-mortem subsystem turns on: `0` is a measured figure,
    // `null` is "nothing to measure". A caller renders a named gap for the second.
    expect(median([])).toBeNull();
  });

  test("an odd-length input returns the middle value", () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  test("an even-length input averages the two middle values", () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  test("a single value is its own median", () => {
    expect(median([7])).toBe(7);
  });

  test("sorts numerically, not lexicographically", () => {
    // The default `Array.prototype.sort` is a STRING sort, which would order these
    // [10, 2, 9] -> ["10", "2", "9"] and return 2. The comparator is load-bearing.
    expect(median([10, 2, 9])).toBe(9);
  });

  test("does not mutate its input", () => {
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
  });

  test("handles negative values", () => {
    expect(median([-5, -1, -3])).toBe(-3);
  });
});
