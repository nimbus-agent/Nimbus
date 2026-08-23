import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { REPO_ROOT } from "../structure-audit/lib.ts";
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

describe("connector audits are wired into CI, not just the local manifest", () => {
  // #1318 added `audit:connector-consent` to PREFLIGHT_GATES and to no workflow, so it gated local
  // runs and no PR — and CI went green precisely because it never ran. `_test-suite.yml` already
  // carries a comment about that exact class of bug from a previous occurrence; this makes it a
  // mechanism instead of a comment.
  //
  // Scoped to `audit:connector-*` deliberately. A blanket check over all 39 manifest gates was
  // measured first and reports 7, most of them false: `audit:any` runs in CI as
  // `count-any-usage.ts --check`, `test:ci` as the suite itself, `lint` under its own step name.
  // This family is invoked as `bun run <name>` every time, so a name match is exact here.
  const workflows = readdirSync(join(REPO_ROOT, ".github", "workflows"))
    .filter((f) => f.endsWith(".yml"))
    .map((f) => readFileSync(join(REPO_ROOT, ".github", "workflows", f), "utf8"))
    .join("\n");

  const connectorGates = PREFLIGHT_GATES.map((g) => g.name).filter((n) =>
    n.startsWith("audit:connector-"),
  );

  test("there is at least one, so a rename cannot make this vacuous", () => {
    expect(connectorGates.length).toBeGreaterThanOrEqual(4);
  });

  for (const name of connectorGates) {
    test(`${name} runs in a workflow`, () => {
      expect(workflows).toContain(name);
    });
  }
});
