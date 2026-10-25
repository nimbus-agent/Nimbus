import { describe, expect, test } from "bun:test";
import { BUNDLED_PACKS } from "./bundled-packs.ts";
import { validatePackContent } from "./pack-validate.ts";

const base = BUNDLED_PACKS.get("pm");
if (base === undefined) throw new Error("pm missing");
const deps = {
  connectorIds: new Set(["slack", "jira", "notion", "google_drive"]),
  agentNames: new Set(["decisions", "glossary", "catchup", "oncall"]),
};
const withAgents = (v: string): string => `[agents]\nvisible = [${v}]\n`;

describe("validatePackContent", () => {
  test("a clean pack has no problems", () => {
    expect(validatePackContent(base, deps)).toEqual([]);
  });

  test("an unknown connector is a problem", () => {
    const p = validatePackContent({ ...base, suggestedConnectors: ["nope"] }, deps);
    expect(p.join(" ")).toContain("nope");
  });

  test("an unknown agent is a problem; agents.oncall is normalised", () => {
    const bad = validatePackContent({ ...base, defaults: withAgents('"owners"') }, deps);
    expect(bad.join(" ")).toContain("owners");
    expect(validatePackContent({ ...base, defaults: withAgents('"agents.oncall"') }, deps)).toEqual(
      [],
    );
  });

  test("an invalid fragment is reported", () => {
    expect(validatePackContent({ ...base, defaults: "x = 1\n" }, deps).length).toBeGreaterThan(0);
  });

  test("a pack may add a new source but not a built-in or personal one", () => {
    const map = (e: string): string => `[sources]\nmap = ["${e}"]\n`;
    const run = (e: string) => validatePackContent({ ...base, defaults: map(e) }, deps);
    expect(run("jira:issue=doc")).toContain('[sources] map names built-in source "jira:issue"');
    expect(run("gmail:email=message")).toContain(
      '[sources] map names personal source "gmail:email"',
    );
    expect(run("readwise:highlight=note")).toEqual([]);
  });
});
