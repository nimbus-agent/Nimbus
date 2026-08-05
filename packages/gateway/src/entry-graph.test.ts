import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const SRC = import.meta.dir;

// Every syntax that creates a STATIC module edge, in either quote style. `export … from` counts:
// a re-export evaluates the target exactly like an import, so `export * from "./gateway-main.ts"`
// in the shim would drag the gateway graph back in — and a guard that missed it would still pass.
// `import type` / `export type` are erased and cannot cause evaluation, so they are excluded.
/** `import … from "./x.ts"` */
const FROM_RE = /^\s*import\s+(?!type\b)[^;]*?from\s+["'](\.[^"']+)["']/gm;
/** Bare side-effect imports: `import "./x.ts";` */
const BARE_RE = /^\s*import\s+["'](\.[^"']+)["']/gm;
/** `export … from "./x.ts"` and `export * from "./x.ts"` */
const REEXPORT_RE = /^\s*export\s+(?!type\b)[^;]*?from\s+["'](\.[^"']+)["']/gm;

/**
 * Most of the tree writes explicit `.ts` specifiers, but not all of it — e.g.
 * `automation/workflow-run-history.ts` imports `"../index/migrations/runner"` extensionless. Bun
 * resolves both, so the walker must too. A specifier that matches no candidate is skipped: bun and
 * tsc already prove every import resolves, and the red-prove below catches a walker that resolves
 * nothing at all.
 */
function resolveSpecifier(fromFile: string, spec: string): string | undefined {
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [base, `${base}.ts`, resolve(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

/**
 * The specifier-recognition half, kept pure so it can be tested against source text directly —
 * no temp file, no path arithmetic, and therefore nothing to break when the repo and the temp
 * directory sit on different Windows drive letters (`path.relative` returns an ABSOLUTE path
 * across drives, which this walker then correctly ignores as non-relative).
 */
function staticSpecifiersOf(source: string): string[] {
  const out: string[] = [];
  for (const re of [FROM_RE, BARE_RE, REEXPORT_RE]) {
    re.lastIndex = 0;
    for (const m of source.matchAll(re)) out.push(m[1] as string);
  }
  return out;
}

function staticDepsOf(file: string): string[] {
  const out: string[] = [];
  for (const spec of staticSpecifiersOf(readFileSync(file, "utf8"))) {
    const resolved = resolveSpecifier(file, spec);
    if (resolved !== undefined) out.push(resolved);
  }
  return out;
}

function transitiveStaticGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const dep of staticDepsOf(file)) stack.push(dep);
  }
  return seen;
}

const STATEFUL = /[\\/](db|vault|ipc)[\\/]/;

// SCOPE: this walker follows STATIC imports only, so it stops at the registry's `() => import(...)`
// thunks and never enters a connector's own graph. That half of the guarantee — no connector
// reaching into the gateway — is enforced by the `mcp-connectors-only-import-sdk` rule in
// .dependency-cruiser.cjs, run by `bun run audit:boundaries` in the fast preflight tier. Do not
// read these assertions as covering connector sources.
describe("the entry shim", () => {
  test("statically imports exactly one module — the runtime layout", () => {
    expect(staticDepsOf(resolve(SRC, "index.ts"))).toEqual([
      resolve(SRC, "platform", "runtime-layout.ts"),
    ]);
  });

  test("the connector role never reaches db/, vault/ or ipc/", () => {
    const graph = [
      ...transitiveStaticGraph(resolve(SRC, "connectors", "run-bundled-connector.ts")),
    ];
    expect(graph.filter((f) => STATEFUL.test(f))).toEqual([]);
  });

  // Red-prove: without this, a walker that silently resolves nothing would make the assertion
  // above pass vacuously. The gateway role MUST reach the stateful modules.
  test("the walker really does traverse — the gateway role reaches db/vault/ipc", () => {
    const graph = [...transitiveStaticGraph(resolve(SRC, "gateway-main.ts"))];
    expect(graph.length).toBeGreaterThan(20);
    expect(graph.some((f) => STATEFUL.test(f))).toBe(true);
  });

  // The bypasses a quote/keyword-specific regex would miss. Each of these creates a real static
  // edge, so a shim using any of them would pull the gateway graph back in while the isolation
  // assertion above still passed.
  test("detects static edges in both quote styles and via re-export", () => {
    const specs = staticSpecifiersOf(
      [
        `import { main } from './gateway-main.ts';`, // single-quoted
        `import { x } from "./platform/runtime-layout.ts";`, // double-quoted
        `export * from "./gateway-main.ts";`, // re-export star
        `export { y } from './connectors/run-bundled-connector.ts';`, // re-export named, single-quoted
        `import "./side-effect.ts";`, // bare side-effect
        `import type { X } from "./version.ts";`, // erased — must NOT be an edge
        `export type { Y } from "./version.ts";`, // erased — must NOT be an edge
        `import { z } from "@mastra/core/agent";`, // bare specifier — not a relative edge
      ].join("\n"),
    );

    expect(specs).toContain("./gateway-main.ts");
    expect(specs).toContain("./platform/runtime-layout.ts");
    expect(specs).toContain("./connectors/run-bundled-connector.ts");
    expect(specs).toContain("./side-effect.ts");
    // `import type` / `export type` are erased at compile time and cannot cause module evaluation,
    // so they must not count as edges — otherwise the isolation assertion would fail on a type-only
    // reference that is provably inert.
    expect(specs).not.toContain("./version.ts");
    // Bare specifiers are package imports, not intra-tree edges.
    expect(specs).not.toContain("@mastra/core/agent");
  });
});
