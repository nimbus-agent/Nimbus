import { describe, expect, test } from "bun:test";

import { detectDrift } from "./drift-check.ts";

describe("detectDrift", () => {
  test("returns false when there is not enough history to fill the window", () => {
    expect(detectDrift([{ value: 100 }, { value: 100 }], 10)).toBe(false);
  });

  test("a single late spike does NOT trip drift (needs n consecutive worse samples)", () => {
    const history = [
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 200 },
    ];
    expect(detectDrift(history, 10)).toBe(false);
  });

  test("a sustained regression (n consecutive samples worse than the rolling median) trips drift", () => {
    const history = [
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 200 },
      { value: 200 },
      { value: 200 },
    ];
    expect(detectDrift(history, 10)).toBe(true);
  });

  test("worse-but-within-the-noise-floor does not trip drift", () => {
    const history = [
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 105 },
      { value: 105 },
      { value: 105 },
    ];
    expect(detectDrift(history, 10)).toBe(false);
  });

  test("a worse sample that breaks the consecutive run resets the counter", () => {
    const history = [
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 200 },
      { value: 200 },
      { value: 100 },
      { value: 200 },
    ];
    expect(detectDrift(history, 10)).toBe(false);
  });

  test("the rolling median is over the last k samples, not the whole history", () => {
    const history = [
      { value: 9000 },
      { value: 9000 },
      { value: 9000 },
      { value: 9000 },
      { value: 9000 },
      { value: 9000 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 200 },
      { value: 200 },
      { value: 200 },
    ];
    expect(detectDrift(history, 10)).toBe(true);
  });

  test("honors a custom k and n", () => {
    const history = [
      { value: 100 },
      { value: 100 },
      { value: 100 },
      { value: 150 },
      { value: 150 },
    ];
    expect(detectDrift(history, 10, 3, 2)).toBe(true);
  });
});
