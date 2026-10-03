import { describe, expect, test } from "bun:test";

import { hasFlag, takeFlag } from "./bench-args.ts";

describe("takeFlag", () => {
  test("returns the argument that follows the flag", () => {
    expect(takeFlag(["--surface", "S1", "--runs", "3"], "--runs")).toBe("3");
  });

  test("the first occurrence wins", () => {
    expect(takeFlag(["--runs", "3", "--runs", "9"], "--runs")).toBe("3");
  });

  test("an absent flag yields undefined", () => {
    expect(takeFlag(["--surface", "S1"], "--runs")).toBeUndefined();
  });

  test("a flag in last position has no value", () => {
    expect(takeFlag(["--surface", "S1", "--runs"], "--runs")).toBeUndefined();
  });

  test("the following token is returned verbatim, even when it is itself a flag", () => {
    expect(takeFlag(["--history", "--gha"], "--history")).toBe("--gha");
  });
});

describe("hasFlag", () => {
  test("is true when the flag appears anywhere", () => {
    expect(hasFlag(["--surface", "S1", "--gha"], "--gha")).toBe(true);
  });

  test("is false when the flag is absent", () => {
    expect(hasFlag(["--surface", "S1"], "--gha")).toBe(false);
  });

  test("matches whole arguments only, never a prefix", () => {
    expect(hasFlag(["--gha-x", "x--gha"], "--gha")).toBe(false);
  });
});
