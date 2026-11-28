import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { DEFAULT_COST_INTERNAL_ENVS, resolveCostConfig } from "./cost-toml.ts";
import { type LayerKind, mergeLayerDocs, parseLayerDoc } from "./layered-merge.ts";

function cfg(...layers: { kind: LayerKind; text: string }[]) {
  const docs = layers.map((l, i) =>
    parseLayerDoc(
      {
        kind: l.kind,
        id: l.kind === "pack" ? `pack${String(i)}` : l.kind,
        path: `/x/${String(i)}`,
      },
      l.text,
    ),
  );
  return resolveCostConfig(mergeLayerDocs(docs).sections);
}
const base = (text: string) => cfg({ kind: "base", text });

describe("[cost] config", () => {
  test("defaults when nothing is configured", () => {
    const c = base("[finops]\nretain_days = 100\n");
    expect(c).toEqual({
      rules: [],
      internalEnvs: DEFAULT_COST_INTERNAL_ENVS,
      authoritative: {},
      focusDir: null,
      githubOrgs: [],
      gitlab: { groups: [], ratePerMinute: null, currency: "USD", runnerRates: [] },
      bitbucket: { workspaces: [], ratePerMinute: null, currency: "USD", sizeRates: [] },
      reports: [],
      reportsError: null,
      error: null,
    });
    expect(DEFAULT_COST_INTERNAL_ENVS).toEqual(["ci", "dev", "test", "staging"]);
  });

  test("internal_envs, authoritative, focus dir and rules in order", () => {
    const exportsDir = resolve("/exports");
    const dir = exportsDir.replaceAll("\\", "\\\\");
    const c = base(`[cost]
internal_envs = ["ci", "sandbox"]
authoritative = { aws = "vantage" }

[cost.focus]
dir = "${dir}"

[[cost.rule]]
match = { provider = "aws", tag = { product = "*" } }
set = { product = "{tag.product}", env = "{tag.env}" }

[[cost.rule]]
match = { source = "github_actions" }
set = { env = "ci", product = "{repo}" }
`);
    expect(c.error).toBeNull();
    expect(c.internalEnvs).toEqual(["ci", "sandbox"]);
    expect(c.authoritative).toEqual({ aws: "vantage" });
    expect(c.focusDir).toBe(exportsDir);
    expect(c.rules.map((r) => [r.index, r.match, r.set])).toEqual([
      [
        1,
        { provider: "aws", tag: { product: "*" } },
        { product: "{tag.product}", env: "{tag.env}" },
      ],
      [2, { source: "github_actions" }, { env: "ci", product: "{repo}" }],
    ]);
  });

  test("a role pack's rules apply until the owner writes their own, which replace them whole", () => {
    const pack = {
      kind: "pack" as const,
      text: '[[cost.rule]]\nmatch = {}\nset = { product = "pack-default" }\n',
    };
    const packOnly = cfg(pack, { kind: "base", text: "[finops]\nretain_days = 100\n" });
    expect(packOnly.rules.map((r) => r.set.product)).toEqual(["pack-default"]);
    const mine = cfg(pack, {
      kind: "base",
      text: '[[cost.rule]]\nmatch = { provider = "aws" }\nset = { product = "mine" }\n',
    });
    expect(mine.rules.map((r) => [r.index, r.set.product])).toEqual([[1, "mine"]]);
  });

  test("an unknown match key refuses the whole cost config, naming it", () => {
    const c = base('[[cost.rule]]\nmatch = { colour = "red" }\nset = { product = "p" }\n');
    expect(c.rules).toEqual([]);
    expect(c.error).toContain('unknown match key "colour"');
  });

  test("an unknown placeholder, an unknown key or section, and bad values are refusals", () => {
    expect(base('[[cost.rule]]\nset = { product = "{owner}" }\n').error).toContain(
      "unknown placeholder {owner}",
    );
    expect(base('[[cost.rule]]\nset = { product = "p" }\nwhen = "x"\n').error).toContain(
      'unknown key "when"',
    );
    expect(base("[cost]\ncolour = 1\n").error).toContain('[cost]: unknown key "colour"');
    expect(base("[cost.nope]\nx = 1\n").error).toContain("unknown section [cost.nope]");
    expect(base("[cost]\ninternal_envs = []\n").error).toContain("internal_envs");
    expect(base('[cost]\ninternal_envs = ["a b"]\n').error).toContain("internal_envs");
    expect(base('[cost.focus]\ndir = "relative/path"\n').error).toContain("absolute path");
    expect(base("[cost]\nauthoritative = 3\n").error).toContain("authoritative");
    expect(base("[[cost.rule]]\nset = { product = \n").error).toContain("not valid TOML");
  });

  test("a malformed header that names a cost table refuses the whole cost config, naming it", () => {
    const later = '\n[[cost.rule]]\nmatch = {}\nset = { product = "other" }\n';
    for (const header of ["[[cost.rule]", "[cost", "[[ cost.rule ]", '["cost".focus']) {
      const c = base(`${header}\nmatch = { provider = "aws" }\nset = { product = "p" }\n${later}`);
      expect(c.rules, header).toEqual([]);
      expect(c.error, header).toBe(`malformed section header ${header}`);
    }
    // A malformed header of another section is not the cost config's business.
    expect(base("[[fleet.node]\nx = 1\n").error).toBeNull();
  });

  test("a line in a cost section that is not key = value refuses the whole cost config", () => {
    const c = base('[[cost.rule]]\nmatch { provider "aws" }\nset = { product = "checkout" }\n');
    expect(c.rules).toEqual([]);
    expect(c.error).toBe('[[cost.rule]] 1: not a key = value line: match { provider "aws" }');
    // Blank lines and comments are not refusals.
    const ok = base(
      '[[cost.rule]]\n# a comment\n\nmatch = { provider = "aws" }\nset = { product = "p" }\n',
    );
    expect(ok.error).toBeNull();
    expect(ok.rules).toHaveLength(1);
    expect(base("[[fleet.node]\nx = 1\n").error).toBeNull();
    expect(base("[costs\nx = 1\n").error).toBeNull();
  });
});

describe("[[cost.report]] and [[cost.report.channel]]", () => {
  const REPORTS = [
    "[[cost.report]]",
    'name = "checkout-weekly"',
    'scope = { product = "checkout" }',
    'period = "week"',
    'schedule = "0 8 * * 1"',
    'tz = "Europe/Berlin"',
    "",
  ].join("\n");
  const SLACK = [
    "[[cost.report.channel]]",
    'report = "checkout-weekly"',
    'kind = "slack"',
    'to = "C0123ABC"',
    'format = "markdown"',
    'template = "Checkout, week of {week_start}: {total} ({change}).\\nTop: {top_movers}"',
    "",
  ].join("\n");

  test("reports and channels are read from their own arrays", () => {
    const c = base(REPORTS + SLACK);
    expect(c.error).toBeNull();
    expect(c.reports.map((r) => [r.name, r.channels.map((ch) => ch.kind)])).toEqual([
      ["checkout-weekly", ["slack"]],
    ]);
    expect(c.reports[0]?.channels[0]?.template).toEqual({
      inline: "Checkout, week of {week_start}: {total} ({change}).\nTop: {top_movers}",
    });
    expect(base("").reports).toEqual([]);
  });

  test("a role pack's reports combine with the owner's channels", () => {
    const c = cfg({ kind: "pack", text: REPORTS }, { kind: "base", text: SLACK });
    expect(c.error).toBeNull();
    expect(c.reports[0]?.channels.map((ch) => ch.to)).toEqual(["C0123ABC"]);
  });

  test("a bad report or channel refuses only the reports; the rules stay in force", () => {
    const rule = '[[cost.rule]]\nmatch = {}\nset = { product = "p" }\n\n';
    const c = base(`${rule}${REPORTS}${SLACK.replace('kind = "slack"', 'kind = "sms"')}`);
    expect(c.reports).toEqual([]);
    expect(c.reportsError).toContain("kind must be one of");
    expect(c.error).toBeNull();
    expect(c.rules.map((r) => r.set.product)).toEqual(["p"]);
    // A refused rule still refuses everything, reports included.
    const both = base(
      `[[cost.rule]]\nmatch = { nope = "x" }\nset = { product = "p" }\n\n${REPORTS}${SLACK}`,
    );
    expect(both.error).toContain("nope");
    expect(both.reports).toEqual([]);
    expect(base('[cost.report]\nname = "x"\n').error).toBe("unknown section [cost.report]");
  });
});

describe("[cost.github] orgs (Phase 7 slice 5)", () => {
  test("absent: no org, nothing is synced", () => {
    expect(base("").githubOrgs).toEqual([]);
  });

  test("a list of org names, kept as written", () => {
    const c = base('[cost.github]\norgs = ["acme", "Acme-Labs"]\n');
    expect(c.error).toBeNull();
    expect(c.githubOrgs).toEqual(["acme", "Acme-Labs"]);
    expect(base("[cost.github]\norgs = []\n").githubOrgs).toEqual([]);
  });

  test("a bad list refuses the whole cost config, naming it", () => {
    const many = Array.from({ length: 21 }, (_, i) => `"o${String(i)}"`).join(", ");
    for (const [text, want] of [
      ['[cost.github]\norgs = "acme"\n', "[cost.github].orgs must be a list"],
      [`[cost.github]\norgs = [${many}]\n`, "at most 20"],
      ['[cost.github]\norgs = ["-bad"]\n', "is not a GitHub organization name"],
      ['[cost.github]\norgs = ["a/b"]\n', "is not a GitHub organization name"],
      [`[cost.github]\norgs = ["${"a".repeat(40)}"]\n`, "is not a GitHub organization name"],
      ['[cost.github]\norgs = ["acme", "ACME"]\n', "is listed twice"],
      ['[cost.github]\norgs = ["acme"]\ntoken = "x"\n', "unknown key"],
    ] as const) {
      const c = base(text);
      expect(c.error, text).toContain(want);
      expect(c.githubOrgs).toEqual([]);
    }
  });
});
