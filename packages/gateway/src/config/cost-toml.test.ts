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
    expect(base("[costs\nx = 1\n").error).toBeNull();
  });
});
