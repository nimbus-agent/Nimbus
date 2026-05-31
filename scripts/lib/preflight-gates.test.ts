import { describe, expect, test } from "bun:test";
import { CI_ONLY_GATES, PREFLIGHT_GATES, selectGates } from "./preflight-gates.ts";

describe("preflight gate manifest", () => {
  test("every gate has a name and a non-empty argv", () => {
    for (const g of PREFLIGHT_GATES) {
      expect(g.name.length).toBeGreaterThan(0);
      expect(g.cmd.length).toBeGreaterThan(0);
      expect(["fast", "full"]).toContain(g.tier);
    }
  });

  test("gate names are unique", () => {
    const names = PREFLIGHT_GATES.map((g) => g.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("selectGates('fast') returns only fast-tier gates", () => {
    expect(selectGates("fast").every((g) => g.tier === "fast")).toBe(true);
  });

  test("selectGates('full') returns every fast gate as a contiguous prefix, then full", () => {
    const full = selectGates("full");
    const fastCount = full.filter((g) => g.tier === "fast").length;
    expect(full.slice(0, fastCount).every((g) => g.tier === "fast")).toBe(true);
    expect(full.slice(fastCount).every((g) => g.tier === "full")).toBe(true);
  });

  test("CI_ONLY_GATES is a non-empty list of strings", () => {
    expect(CI_ONLY_GATES.length).toBeGreaterThan(0);
    expect(CI_ONLY_GATES.every((s) => typeof s === "string")).toBe(true);
  });
});
