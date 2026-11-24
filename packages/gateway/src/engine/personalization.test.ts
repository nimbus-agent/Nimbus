import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNimbusTomlPersonalization } from "../config/personalization-toml.ts";
import {
  applyToolPreferences,
  mergePersonaTone,
  personalizationDeps,
  resetToolPreferenceWarningsForTest,
  resolveAskStyle,
  verbosityDirective,
} from "./personalization.ts";

const prefs = (toml: string) => parseNimbusTomlPersonalization(`[personalization]\n${toml}`);
const tools = { a: 1, b: 2, c: 3 };

describe("applyToolPreferences", () => {
  test("no preferences returns the same map", () => {
    expect(applyToolPreferences(tools, undefined)).toBe(tools);
    expect(applyToolPreferences(tools, prefs(""))).toBe(tools);
  });
  test("hide removes, order moves, membership never grows", () => {
    const out = applyToolPreferences(
      tools,
      prefs('hide_tools = ["b", "zzz"]\ntool_order = ["c", "yyy"]'),
    );
    expect(Object.keys(out)).toEqual(["c", "a"]);
  });
  test("warns once per unmatched name, only on a complete turn", () => {
    resetToolPreferenceWarningsForTest();
    const seen: string[] = [];
    const p = prefs('hide_tools = ["gone"]');
    applyToolPreferences(tools, p, { complete: false, warn: (n) => seen.push(n) });
    expect(seen).toEqual([]);
    applyToolPreferences(tools, p, { complete: true, warn: (n) => seen.push(n) });
    applyToolPreferences(tools, p, { complete: true, warn: (n) => seen.push(n) });
    expect(seen).toEqual(["gone"]);
  });
});

describe("style", () => {
  test("verbosity directives are fixed sentences; default adds nothing", () => {
    expect(verbosityDirective(prefs('verbosity = "default"'))).toBe("");
    expect(verbosityDirective(undefined)).toBe("");
    expect(verbosityDirective(prefs('verbosity = "brief"'))).toContain("compact");
    expect(verbosityDirective(prefs('verbosity = "detailed"'))).toContain("fuller");
  });
  test("personalization tone replaces [persona] tone only when set", () => {
    const base = { tone: "casual", voice: "collective" } as const;
    expect(mergePersonaTone(base, prefs(""))).toBe(base);
    expect(mergePersonaTone(base, prefs('tone = "formal"'))).toEqual({
      tone: "formal",
      voice: "collective",
    });
  });
  test("resolveAskStyle and personalizationDeps read the layered file per call", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-pers-"));
    writeFileSync(
      join(dir, "nimbus.toml"),
      '[personalization]\ntone = "terse"\nverbosity = "brief"\nbogus = 1\n',
    );
    const style = resolveAskStyle(dir);
    expect(style.persona.tone).toBe("terse");
    expect(style.verbosity).toContain("compact");
    const logged: string[] = [];
    const d = personalizationDeps(dir, { warn: (_o, m) => logged.push(m) });
    d.get();
    d.get();
    d.warn("x", "m");
    expect(logged.filter((m) => m.includes("bogus"))).toHaveLength(1);
  });
});
