import { describe, expect, test } from "bun:test";

import { codeUnitCompare } from "./code-unit-compare.ts";

describe("codeUnitCompare", () => {
  test("returns -1 when a sorts before b", () => {
    expect(codeUnitCompare("a", "b")).toBe(-1);
    expect(codeUnitCompare("A", "a")).toBe(-1); // uppercase code units precede lowercase
    expect(codeUnitCompare("", "x")).toBe(-1);
  });

  test("returns 1 when a sorts after b", () => {
    expect(codeUnitCompare("b", "a")).toBe(1);
    expect(codeUnitCompare("a", "A")).toBe(1);
    expect(codeUnitCompare("x", "")).toBe(1);
  });

  test("returns 0 for equal strings", () => {
    expect(codeUnitCompare("same", "same")).toBe(0);
    expect(codeUnitCompare("", "")).toBe(0);
  });

  test("orders an array by code unit (matches default Array.sort)", () => {
    const input = ["banana", "Apple", "apple", "Banana"];
    const sorted = [...input].sort(codeUnitCompare);
    expect(sorted).toEqual([...input].sort());
  });
});
