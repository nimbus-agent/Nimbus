import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CI_ONLY_GATES, PREFLIGHT_GATES } from "./lib/preflight-gates.ts";
import { REPO_ROOT } from "./structure-audit/lib.ts";

/**
 * Extract `bun run <script>` and `bunx <tool>` gate ids from a workflow file.
 * Flag-tolerant: matches `bun run X`, `bun --bun run X`, `bunx X`, `bunx --bun X`
 * so an intervening runtime flag can't silently hide a gate (review Q1).
 *
 * Each intervening-flag group is `\s+-\S+` (whitespace, then a dash-led token).
 * `\s`/`\S` are disjoint so the input partitions exactly one way — this avoids
 * the exponential backtracking a `(?:\s+--?[\w-]+)*` form would have on inputs
 * like `-- -- --` (CodeQL js/redos).
 */
export function extractWorkflowGates(yaml: string): string[] {
  const gates = new Set<string>();
  for (const m of yaml.matchAll(/\bbun(?:\s+-\S+)*\s+run\s+([a-z][\w:-]+)/g))
    if (m[1]) gates.add(m[1]);
  for (const m of yaml.matchAll(/\bbunx(?:\s+-\S+)*\s+([a-z][\w@/-]+)/g)) if (m[1]) gates.add(m[1]);
  return [...gates];
}

function manifestScriptIds(): Set<string> {
  const ids = new Set<string>();
  for (const g of PREFLIGHT_GATES) {
    // "bun run X" -> X ; "bunx Y ..." -> Y
    if (g.cmd[0] === "bun" && g.cmd[1] === "run" && g.cmd[2]) ids.add(g.cmd[2]);
    if (g.cmd[0] === "bunx" && g.cmd[1]) ids.add(g.cmd[1]);
  }
  for (const c of CI_ONLY_GATES) ids.add(c);
  return ids;
}

describe("preflight drift guard", () => {
  test("extractWorkflowGates pulls bun run + bunx ids", () => {
    const y = "      - run: bun run audit:boundaries\n      - run: bunx jscpd packages/\n";
    expect(extractWorkflowGates(y).sort()).toEqual(["audit:boundaries", "jscpd"]);
  });

  test("extractWorkflowGates tolerates intervening flags (--bun)", () => {
    const y = "      - run: bun --bun run audit:any\n      - run: bunx --bun vitest run\n";
    expect(extractWorkflowGates(y).sort()).toEqual(["audit:any", "vitest"]);
  });

  test("every workflow bun run/bunx gate is in the manifest or CI_ONLY_GATES", () => {
    const dir = join(REPO_ROOT, ".github", "workflows");
    const known = manifestScriptIds();
    const missing: string[] = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".yml") || n.endsWith(".yaml"))) {
      const gates = extractWorkflowGates(readFileSync(join(dir, f), "utf8"));
      for (const g of gates) if (!known.has(g)) missing.push(`${f}: ${g}`);
    }
    expect(missing).toEqual([]);
  });
});
