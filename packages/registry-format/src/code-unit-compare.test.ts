import { describe, expect, test } from "bun:test";
import { codeUnitCompare } from "./code-unit-compare.ts";

describe("codeUnitCompare", () => {
  test("orders by UTF-16 code unit, the same as a bare sort()", () => {
    const xs = ["b", "B", "a", "_x", "Z", "a.b", "a/b", "ä"];
    expect([...xs].sort(codeUnitCompare)).toEqual([...xs].sort());
  });

  test("is not locale order: uppercase sorts before lowercase", () => {
    expect(codeUnitCompare("Z", "a")).toBe(-1);
    expect(codeUnitCompare("a", "Z")).toBe(1);
  });

  test("equal strings compare 0", () => {
    expect(codeUnitCompare("acme/echo", "acme/echo")).toBe(0);
  });
});
