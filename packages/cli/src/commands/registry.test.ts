import { describe, expect, it } from "bun:test";

import { COMMAND_NAMES, type CommandName } from "./registry.ts";

describe("COMMAND_NAMES — registry contract", () => {
  it("is a non-empty readonly tuple of strings", () => {
    expect(Array.isArray(COMMAND_NAMES)).toBe(true);
    expect(COMMAND_NAMES.length).toBeGreaterThan(0);
    for (const name of COMMAND_NAMES) {
      expect(typeof name).toBe("string");
    }
  });

  it("contains no duplicates", () => {
    const set = new Set(COMMAND_NAMES);
    expect(set.size).toBe(COMMAND_NAMES.length);
  });

  it("includes the load-bearing built-in commands", () => {
    const required = [
      "ask",
      "config",
      "connector",
      "extension",
      "help",
      "query",
      "search",
      "session",
      "start",
      "stop",
      "vault",
    ];
    for (const r of required) {
      expect(COMMAND_NAMES).toContain(r as CommandName); // NOSONAR S4325: r is a raw string from the iteration; toContain expects CommandName
    }
  });

  it("includes Phase 5 surface (CI/CD + agents + people)", () => {
    expect(COMMAND_NAMES).toContain("deploy");
    expect(COMMAND_NAMES).toContain("metrics");
    expect(COMMAND_NAMES).toContain("expert");
    expect(COMMAND_NAMES).toContain("impact");
    expect(COMMAND_NAMES).toContain("people");
  });

  it("entries are kebab-cased lowercase identifiers (no spaces, no slashes)", () => {
    for (const n of COMMAND_NAMES) {
      expect(n).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });
});
