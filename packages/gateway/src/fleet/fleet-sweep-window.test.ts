import { describe, expect, test } from "bun:test";
import { selectSweepWindow } from "./fleet-sweep-window.ts";

describe("selectSweepWindow", () => {
  const keys = ["a", "b", "c", "d", "e"];

  test("a null cursor starts at the first key", () => {
    expect(selectSweepWindow(keys, null, 2)).toEqual(["a", "b"]);
  });

  test("starts strictly after the cursor and wraps", () => {
    expect(selectSweepWindow(keys, "d", 3)).toEqual(["e", "a", "b"]);
  });

  test("a cursor past the last key wraps to the start", () => {
    expect(selectSweepWindow(keys, "z", 2)).toEqual(["a", "b"]);
  });

  test("a DELETED cursor key neither skips nor repeats — next greater key", () => {
    expect(selectSweepWindow(["a", "b", "d", "e"], "c", 2)).toEqual(["d", "e"]);
  });

  test("an ADDED key after the cursor is picked up in order", () => {
    expect(selectSweepWindow(["a", "b", "bb", "c"], "b", 2)).toEqual(["bb", "c"]);
  });

  test("a list no longer than max is taken whole, once — never padded by wrapping", () => {
    expect(selectSweepWindow(["a", "b"], "a", 5)).toEqual(["a", "b"]);
  });

  test("sorts its input by code unit rather than trusting caller order", () => {
    expect(selectSweepWindow(["c", "a", "b"], null, 2)).toEqual(["a", "b"]);
  });

  test("empty in, empty out", () => {
    expect(selectSweepWindow([], "a", 3)).toEqual([]);
  });
});
