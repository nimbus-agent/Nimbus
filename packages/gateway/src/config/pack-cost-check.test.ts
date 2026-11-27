// Phase 7 slice 7 (I47): the three cost defaults a role pack may set, checked by the real cost compiler, and
// everything around them a pack may not set (above all a report channel: a pack never chooses a destination).
import { describe, expect, test } from "bun:test";
import { BUNDLED_PACKS } from "../packs/bundled-packs.ts";
import { packCostSummary } from "./pack-cost-check.ts";
import { checkPackFragment, type PackJobChecker } from "./pack-settable.ts";

const none: PackJobChecker = () => [];

function problemsOf(text: string): readonly string[] {
  const r = checkPackFragment(text, none);
  if (r.ok) throw new Error("expected a refusal");
  return r.problems;
}

const RULE = '[[cost.rule]]\nmatch = { provider = "aws" }\nset = { product = "platform" }\n';
const REPORT = '[[cost.report]]\nname = "weekly"\nscope = { env = "prod" }\nperiod = "week"\n';

describe("pack cost defaults: accepted", () => {
  test("the bundled finops fragment passes and is marked as setting cost", () => {
    const defaults = BUNDLED_PACKS.get("finops")?.defaults ?? "";
    const r = checkPackFragment(defaults, none);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cost).toBe(true);
    expect(r.lists.get("cost.internal_envs")).toEqual(["ci", "dev", "test", "staging"]);
  });

  test.each([
    ["internal_envs alone", '[cost]\ninternal_envs = ["ci"]\n'],
    ["a rule alone", RULE],
    ["a report alone", REPORT],
  ])("%s", (_name, text) => {
    const r = checkPackFragment(text, none);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.cost).toBe(true);
  });

  test("a fragment with no cost table is not marked as setting cost", () => {
    const r = checkPackFragment("[fleet]\nenabled = true\n", none);
    expect(r.ok && r.cost).toBe(false);
  });
});

describe("pack cost defaults: refused", () => {
  test("a pack can never set a report channel (it would choose where cost data goes)", () => {
    const channel =
      '[[cost.report.channel]]\nreport = "weekly"\nkind = "slack"\nto = "C0123ABC"\nformat = "text"\ntemplate = "{total}"\n';
    expect(problemsOf(REPORT + channel)).toContain("[[cost.report.channel]] is not pack-settable");
  });

  test("a report cannot carry a channel's keys inline", () => {
    const p = problemsOf(`${REPORT}kind = "slack"\nto = "C0123ABC"\n`);
    expect(p.some((x) => x.startsWith("cost: ") && x.includes('unknown key "kind"'))).toBe(true);
  });

  test.each([
    [
      "[cost] authoritative",
      '[cost]\nauthoritative = { aws = "vantage" }\n',
      "[cost] authoritative is not pack-settable",
    ],
    ["[cost.focus]", '[cost.focus]\ndir = "/tmp/x"\n', "[cost.focus] dir is not pack-settable"],
    [
      "[cost.github]",
      '[cost.github]\norgs = ["acme"]\n',
      "[cost.github] orgs is not pack-settable",
    ],
  ])("%s", (_name, text, problem) => {
    expect(problemsOf(text)).toContain(problem);
  });

  test("a rule the owner's own file could not set is refused by the same compiler", () => {
    const p = problemsOf(
      '[[cost.rule]]\nmatch = { provider = "aws" }\nset = { product = "{nope}" }\n',
    );
    expect(p.length).toBe(1);
    expect(p[0]).toStartWith("cost: ");
  });

  test("a report with no scope is refused", () => {
    expect(problemsOf('[[cost.report]]\nname = "weekly"\nperiod = "week"\n')).toEqual([
      "cost: [[cost.report]] 1: scope must name at least one of product, env, service, provider",
    ]);
  });

  test("a bad env value and an over-long env list are refused", () => {
    expect(problemsOf('[cost]\ninternal_envs = ["has space"]\n')[0]).toStartWith(
      "[cost] internal_envs = ",
    );
    const many = `[${Array.from({ length: 33 }, (_, i) => `"e${String(i)}"`).join(", ")}]`;
    expect(problemsOf(`[cost]\ninternal_envs = ${many}\n`)[0]).toStartWith(
      "[cost] internal_envs = ",
    );
  });

  test("a cost block line that is not key = value is refused", () => {
    const p = problemsOf(`${RULE}this is not toml\n`);
    expect(p.some((x) => x.startsWith("cost: ") && x.includes("not a key = value line"))).toBe(
      true,
    );
  });
});

describe("packCostSummary", () => {
  test("names the envs, the rule count and each report, and says a report sends nothing yet", () => {
    expect(packCostSummary(BUNDLED_PACKS.get("finops")?.defaults ?? "")).toEqual([
      "internal environments: ci, dev, test, staging (your own [cost] internal_envs replaces them)",
      "2 allocation rule(s), first match wins (your own [[cost.rule]] replaces them all)",
      "report prod-weekly: env=prod, per week; it sends nothing until you add a [[cost.report.channel]] for it",
    ]);
  });

  test("is empty for a pack with no cost defaults", () => {
    expect(packCostSummary("[fleet]\nenabled = true\n")).toEqual([]);
  });
});
