import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CI_ONLY_GATES, PREFLIGHT_GATES } from "./lib/preflight-gates.ts";
import { REPO_ROOT } from "./structure-audit/lib.ts";

/**
 * Drop whole-line comments before scanning.
 *
 * This is a raw-text scan over YAML, with no idea what is a `run:` step and what is
 * prose — so a COMMENT that merely mentions a gate used to register as a gate CI
 * runs. `docs-quality.yml` now carries the line
 * `# Runs the SAME script as \`bun run audit:links\``, which reported a phantom
 * `audit:links` gate and failed this guard, even though nothing in that workflow
 * invokes it.
 *
 * Only lines whose first non-space character is `#` are dropped, which is the one
 * shape that provably cannot execute anything — in YAML and in a `run: |` shell block
 * alike. A trailing `#` is deliberately left alone: stripping to end-of-line would
 * also eat a `#` inside a quoted string, and the failure mode there is a MISSED gate,
 * which is far worse for a guard than a spurious one.
 */
function stripCommentLines(yaml: string): string {
  return yaml
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

export function extractWorkflowGates(yaml: string): string[] {
  const source = stripCommentLines(yaml);
  const gates = new Set<string>();
  for (const m of source.matchAll(/\bbun(?:\s+-\S+)*\s+run\s+([a-z][\w:-]+)/g))
    if (m[1]) gates.add(m[1]);
  for (const m of source.matchAll(/\bbunx(?:\s+-\S+)*\s+([a-z][\w@/-]+)/g))
    if (m[1]) gates.add(m[1]);
  return [...gates];
}

function manifestScriptIds(): Set<string> {
  const ids = new Set<string>();
  for (const g of PREFLIGHT_GATES) {
    if (g.cmd[0] === "bun" && g.cmd[1] === "run" && g.cmd[2]) ids.add(g.cmd[2]);
    if (g.cmd[0] === "bunx" && g.cmd[1]) ids.add(g.cmd[1]);
  }
  for (const c of CI_ONLY_GATES) ids.add(c);
  return ids;
}

describe("preflight drift guard", () => {
  test("extractWorkflowGates pulls bun run + bunx ids", () => {
    const y = "      - run: bun run audit:boundaries\n      - run: bunx jscpd packages/\n";
    expect(extractWorkflowGates(y).sort((a, b) => a.localeCompare(b))).toEqual([
      "audit:boundaries",
      "jscpd",
    ]);
  });

  test("extractWorkflowGates tolerates intervening flags (--bun)", () => {
    const y = "      - run: bun --bun run audit:any\n      - run: bunx --bun vitest run\n";
    expect(extractWorkflowGates(y).sort((a, b) => a.localeCompare(b))).toEqual([
      "audit:any",
      "vitest",
    ]);
  });

  test("a comment that MENTIONS a gate is not a gate", () => {
    // The regression this guard hit for real: a `#` line in docs-quality.yml
    // documenting that the step "runs the same script as `bun run audit:links`"
    // was scanned as an invocation, so the guard demanded a manifest entry for a
    // gate the workflow does not run.
    const y = [
      "      # Runs the SAME script as `bun run audit:links`, so CI cannot drift.",
      "        # bunx some-tool — described, not invoked",
      "      - run: bun run audit:boundaries",
    ].join("\n");
    expect(extractWorkflowGates(y)).toEqual(["audit:boundaries"]);
  });

  test("a trailing comment is NOT stripped, so a real gate is never missed", () => {
    // Deliberate asymmetry: under-reporting would let a genuine CI gate slip past
    // this guard unnoticed, which is worse than reporting one that is only named.
    const y = "      - run: bun run audit:any  # keep this gate\n";
    expect(extractWorkflowGates(y)).toEqual(["audit:any"]);
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
