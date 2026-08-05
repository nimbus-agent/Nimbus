import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

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

function staticDepsOf(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const re of [FROM_RE, BARE_RE, REEXPORT_RE]) {
    re.lastIndex = 0;
    for (const m of src.matchAll(re)) {
      const resolved = resolveSpecifier(file, m[1] as string);
      if (resolved !== undefined) out.push(resolved);
    }
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
    const probe = join(tmpdir(), `nimbus-entry-graph-probe-${String(process.pid)}.ts`);
    // Relative specifiers, because the walker only follows relative edges — an absolute specifier
    // is correctly ignored. Written outside src/ so a crash cannot leave a stray module behind.
    const rel = (...seg: string[]): string =>
      relative(dirname(probe), resolve(SRC, ...seg)).replaceAll("\\", "/");
    writeFileSync(
      probe,
      [
        `import { main } from '${rel("gateway-main.ts")}';`,
        `export * from "${rel("platform", "runtime-layout.ts")}";`,
        `import type { X } from "${rel("version.ts")}";`,
      ].join("\n"),
    );
    try {
      const deps = staticDepsOf(probe);
      expect(deps).toContain(resolve(SRC, "gateway-main.ts")); // single-quoted import
      expect(deps).toContain(resolve(SRC, "platform", "runtime-layout.ts")); // export * from
      expect(deps).not.toContain(resolve(SRC, "version.ts")); // `import type` is erased
    } finally {
      rmSync(probe, { force: true });
    }
  });
});
