import { describe, expect, test } from "bun:test";

import { findUnreachable } from "./check-team-reachability.ts";

describe("findUnreachable", () => {
  test("passes when every repo is in a team grant", () => {
    const result = findUnreachable(["a", "b"], ["a", "b", "b"], []);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("flags a repo reachable through no team", () => {
    const result = findUnreachable(["a", "b", "c"], ["a", "b"], []);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("c");
    expect(result.errors[0]).toContain("no team");
  });

  test("an exempt teamless repo is not flagged", () => {
    const result = findUnreachable(["a", "b", "c"], ["a", "b"], ["c"]);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("empty inputs pass", () => {
    const result = findUnreachable([], [], []);
    expect(result.ok).toBe(true);
  });

  test("flags multiple teamless repos", () => {
    const result = findUnreachable(["a", "b", "c"], [], []);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(3);
  });
});
