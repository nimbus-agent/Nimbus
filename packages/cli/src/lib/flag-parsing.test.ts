import { describe, expect, it } from "bun:test";

import { hasFlag, shiftFlag } from "./flag-parsing.ts";

describe("hasFlag", () => {
  it("returns true and splices the flag when present", () => {
    const args = ["--json", "--foo", "bar"];
    const result = hasFlag(args, "--foo");
    expect(result).toBe(true);
    expect(args).toEqual(["--json", "bar"]);
  });

  it("returns false and leaves args unchanged when flag absent", () => {
    const args = ["--json", "bar"];
    const result = hasFlag(args, "--foo");
    expect(result).toBe(false);
    expect(args).toEqual(["--json", "bar"]);
  });

  it("splices only the first occurrence when flag appears multiple times", () => {
    const args = ["--flag", "--flag"];
    const result = hasFlag(args, "--flag");
    expect(result).toBe(true);
    expect(args).toEqual(["--flag"]);
  });

  it("works on a single-element array", () => {
    const args = ["--dry-run"];
    const result = hasFlag(args, "--dry-run");
    expect(result).toBe(true);
    expect(args).toHaveLength(0);
  });

  it("returns false on an empty array", () => {
    const args: string[] = [];
    const result = hasFlag(args, "--dry-run");
    expect(result).toBe(false);
    expect(args).toHaveLength(0);
  });
});

describe("shiftFlag", () => {
  it("returns the next arg and splices both flag and value when present", () => {
    const args = ["--since", "3d", "--json"];
    const result = shiftFlag(args, "--since");
    expect(result).toBe("3d");
    expect(args).toEqual(["--json"]);
  });

  it("returns undefined when flag is absent", () => {
    const args = ["--json"];
    const result = shiftFlag(args, "--since");
    expect(result).toBeUndefined();
    expect(args).toEqual(["--json"]);
  });

  it("returns undefined when flag is last element (no following value)", () => {
    const args = ["--since"];
    const result = shiftFlag(args, "--since");
    expect(result).toBeUndefined();
    expect(args).toEqual(["--since"]);
  });

  it("returns empty string value when value is an empty string", () => {
    const args = ["--agent", "", "--json"];
    const result = shiftFlag(args, "--agent");
    expect(result).toBe("");
    expect(args).toEqual(["--json"]);
  });

  it("returns undefined on an empty array", () => {
    const args: string[] = [];
    const result = shiftFlag(args, "--agent");
    expect(result).toBeUndefined();
  });

  it("splices only the first occurrence when flag appears multiple times", () => {
    const args = ["--file", "a.json", "--file", "b.json"];
    const result = shiftFlag(args, "--file");
    expect(result).toBe("a.json");
    expect(args).toEqual(["--file", "b.json"]);
  });
});
