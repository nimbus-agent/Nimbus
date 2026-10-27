import { describe, expect, test } from "bun:test";
import { codeUnitCompare } from "./code-unit-compare.ts";
import { ancestorsOf, successorsOf } from "./rotation-graph.ts";

const e = (from: string, to: string) => ({ from, to });
const all = (): boolean => true;
const sorted = (s: Set<string>): string[] => [...s].sort(codeUnitCompare);

describe("ancestorsOf", () => {
  test("walks back through chains and terminates on cycles", () => {
    expect(sorted(ancestorsOf([e("k", "x"), e("x", "y")], "y"))).toEqual(["k", "x"]);
    expect([...ancestorsOf([e("a", "b"), e("b", "a")], "a")]).toEqual(["b"]);
    expect(ancestorsOf([], "y").size).toBe(0);
  });
});

describe("successorsOf", () => {
  test("one chain has one terminal; a fork two; an unusable start none", () => {
    expect([...successorsOf([e("k", "x"), e("x", "y")], "k", all).terminal]).toEqual(["y"]);
    expect(successorsOf([e("k", "x"), e("k", "y")], "k", all).terminal.size).toBe(2);
    expect(successorsOf([e("k", "x")], "k", (f) => f !== "k").reachable.size).toBe(0);
  });

  test("a cycle among successors, or a loop back to the start, leaves no terminal key", () => {
    expect(successorsOf([e("k", "x"), e("x", "y"), e("y", "x")], "k", all).terminal.size).toBe(0);
    expect(successorsOf([e("k", "x"), e("x", "k")], "k", all).terminal.size).toBe(0);
  });

  test("an unusable middle key stops the walk there", () => {
    const r = successorsOf([e("k", "x"), e("x", "y")], "k", (f) => f !== "x");
    expect(r.reachable.size).toBe(0);
    expect(r.terminal.size).toBe(0);
  });

  test("a key with no onward rotation reaches nothing", () => {
    const r = successorsOf([e("a", "b")], "k", all);
    expect(r.reachable.size).toBe(0);
  });
});
