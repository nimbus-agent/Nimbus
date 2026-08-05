# Compiled-Runtime Connector Spawn (Cluster 1, PR 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a `bun build --compile` gateway binary able to spawn every one of the 94 first-party
MCP connectors, which it cannot do today — every spawn site hardcodes `command: "bun"` plus a path
into a source tree the binary does not ship with.

**Architecture:** The gateway executable gains two extra roles selected by `argv[2]`
(`__nimbus-sandbox`, `__nimbus-connector <id>`), and carries the connector servers in its own build
graph via a generated registry. `src/index.ts` becomes a thin shim that dynamically imports exactly
one role module, so a connector role never evaluates the gateway module graph. One module,
`platform/runtime-layout.ts`, is the only place the compiled and dev runtime shapes are
distinguished.

**Tech Stack:** Bun v1.2+ (CI runs 1.3), TypeScript 7.x strict, `bun:test`, Biome,
`@modelcontextprotocol/sdk`, zod.

## Global Constraints

- **No `any`.** Use `unknown` for external data. TypeScript strict mode is non-negotiable.
- **Platform equality.** Windows/macOS/Linux equally supported. Build paths with `path.join()` /
  `path.resolve()`, never hardcoded separators. `bun run audit:cross-platform` flags Windows-separator
  path assertions.
- **MCP as connector standard.** The spawned connector remains a separate process speaking MCP over
  stdio. Nothing in this plan makes the gateway call a cloud API directly.
- **I15 / D10 unchanged.** Every `ServerSpec` still passes through `wrapServerSpec()`. Only the
  *contents* of `command` and `args` change.
- **Dependency injection over `mock.module`.** `mock.module` contaminates the combined
  `bun test packages/cli/src` run on CI Linux. Every seam below is a parameter with a default.
- **Never `git add -A`** — `.claude/settings.local.json` is tracked.
- **Before pushing:** `bun run preflight:fast`.
- **Commits:** conventional-commit prefixes. The commit message is discarded on squash-merge; the PR
  title and body become the commit.

## Measured facts this plan depends on

Verified against this tree on 2026-08-05. Do not re-derive; do not assume otherwise.

- Compiled `import.meta.dir` is `/$bunfs/root` (POSIX) and `B:\~BUN\root` (Windows).
- Compiled `process.argv` is `["bun", "<bunfs>/<name>", ...userArgs]` — `argv.slice(2)` is identical
  in both runtime shapes.
- Compiled `process.execPath` is the full binary path **including `.exe`** on Windows.
- 94 packages under `packages/mcp-connectors/` have a `src/server.ts`.
- Bundling all 94 into one binary: 676 modules, 0.44 s, 97.7 MB versus a 93.9 MB baseline (+4.0%).
- 82 spawn sites use `command: "bun"` + `mcpConnectorServerScript(...)`: 31 in `connector-spawns.ts`,
  49 in `phase3-config.ts`, 2 in `chatops-bot-spawn.ts`.
- Connector bootstrap shapes: 10 guarded (`if (import.meta.main)`) + helper, 50 unguarded + helper,
  34 unguarded + explicit `server.connect(transport)`.

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/gateway/src/platform/runtime-layout.ts` | **Create.** The only module that distinguishes compiled from dev; owns the role sentinels and `selfSpawn`. |
| `packages/gateway/src/platform/runtime-layout.test.ts` | **Create.** Both runtime shapes, injected. |
| `packages/mcp-connectors/{argocd,bigeye,flux,looker,mlflow,monte-carlo,powerbi,snowflake,tableau,workday}/src/server.ts` | **Modify.** Export `startConnector()`; keep the `import.meta.main` guard. |
| `scripts/structure-audit/check-connector-entrypoints.ts` | **Create.** A `server.ts` with `import.meta.main` must export `startConnector`. |
| `scripts/structure-audit/check-connector-entrypoints.test.ts` | **Create.** Fixture-driven, with a red-prove. |
| `scripts/structure-audit/check-connector-deps.ts` | **Create.** Connector runtime dependencies stay within an allowlist. |
| `scripts/structure-audit/check-connector-deps.test.ts` | **Create.** Fixture-driven, with a red-prove. |
| `scripts/gen-bundled-connector-registry.ts` | **Create.** Generates the registry from disk; re-runnable. |
| `packages/gateway/src/connectors/bundled-connector-registry.ts` | **Create (generated).** id → lazy dynamic import of the connector's `server.ts`. |
| `packages/gateway/src/connectors/bundled-connector-registry.test.ts` | **Create.** Drift test that re-derives the id set from disk independently. |
| `packages/gateway/src/connectors/run-bundled-connector.ts` | **Create.** Resolves an id, imports it, calls `startConnector` when exported. |
| `packages/gateway/src/connectors/run-bundled-connector.test.ts` | **Create.** Injected fake registry. |
| `packages/gateway/src/gateway-main.ts` | **Create.** Everything today's `index.ts` does, as an exported `main()`. |
| `packages/gateway/src/index.ts` | **Rewrite.** Thin argv shim; three dynamic role imports. |
| `packages/gateway/src/entry-graph.test.ts` | **Create.** Static import-graph assertions over the shim. |
| `packages/gateway/src/platform/sandbox/sandbox-wrapper.ts` | **Modify.** `main()` becomes exported `runSandboxWrapper(args)`; drop the top-level call. |
| `packages/gateway/src/connectors/lazy-mesh/keys.ts` | **Modify.** `mcpConnectorServerScript` → `connectorSpawn`; delete `MCP_CONNECTORS_ROOT`. |
| `packages/gateway/src/connectors/lazy-mesh/{connector-spawns,phase3-config,chatops-bot-spawn}.ts` | **Modify.** 82 spawn sites. |
| `packages/gateway/src/connectors/lazy-mesh/wrap-server-spec.ts` | **Modify.** Build the command through `selfSpawn("sandbox", …)`; delete `SANDBOX_WRAPPER_PATH`. |
| `packages/gateway/src/connectors/lazy-mesh/wrap-server-spec.test.ts` | **Modify.** Assertions follow the new argv shape. |
| `scripts/connector-boot-smoke.ts` | **Create.** Boots all 94 from a compiled binary. |
| `scripts/coverage-floor/exclusions.ts` | **Modify.** Exact-path exclusion for the generated registry. |
| `scripts/lib/preflight-gates.ts` | **Modify.** Register the two new audits (fast) and the boot smoke (full). |
| `package.json` | **Modify.** Three new scripts. |
| `.github/workflows/_test-suite.yml` | **Modify.** Run the boot smoke in the existing compiled-binary job. |

---

### Task 1: `runtime-layout.ts` — the single answer to "where am I"

**Files:**

- Create: `packages/gateway/src/platform/runtime-layout.ts`
- Create: `packages/gateway/src/platform/runtime-layout.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `ROLE_SENTINELS` (`{ sandbox: "__nimbus-sandbox"; connector: "__nimbus-connector" }`),
  `type SelfRole = "sandbox" | "connector"`, `interface RuntimeLayout { execPath: string; moduleDir:
  string; gatewayEntry: string }`, `DEFAULT_RUNTIME_LAYOUT: RuntimeLayout`,
  `isCompiledBinary(layout?): boolean`, `selfSpawn(role, args?, layout?): { command: string; args:
  string[] }`. Tasks 4, 5 and 6 consume all of these.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/platform/runtime-layout.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";

import {
  DEFAULT_RUNTIME_LAYOUT,
  isCompiledBinary,
  ROLE_SENTINELS,
  type RuntimeLayout,
  selfSpawn,
} from "./runtime-layout.ts";

/** A dev tree: the gateway runs under `bun packages/gateway/src/index.ts`. */
const DEV: RuntimeLayout = {
  execPath: "/usr/local/bin/bun",
  moduleDir: "/repo/packages/gateway/src/platform",
  gatewayEntry: "/repo/packages/gateway/src/index.ts",
};

/** Measured value of `import.meta.dir` inside a compiled binary on POSIX. */
const COMPILED_POSIX: RuntimeLayout = {
  execPath: "/opt/nimbus/nimbus-gateway",
  moduleDir: "/$bunfs/root",
  gatewayEntry: "/$bunfs/root/index.ts",
};

/** Measured value of `import.meta.dir` inside a compiled binary on Windows. */
const COMPILED_WIN: RuntimeLayout = {
  execPath: "C:\\Program Files\\Nimbus\\nimbus-gateway.exe",
  moduleDir: "B:\\~BUN\\root",
  gatewayEntry: "B:\\~BUN\\root\\index.ts",
};

describe("isCompiledBinary", () => {
  test("is false in a dev tree", () => {
    expect(isCompiledBinary(DEV)).toBe(false);
  });

  test("is true for the POSIX bunfs root", () => {
    expect(isCompiledBinary(COMPILED_POSIX)).toBe(true);
  });

  test("is true for the Windows bunfs root", () => {
    expect(isCompiledBinary(COMPILED_WIN)).toBe(true);
  });

  test("is false for a real directory that merely mentions bun", () => {
    expect(isCompiledBinary({ ...DEV, moduleDir: "/home/dev/bunfs/src" })).toBe(false);
  });
});

describe("selfSpawn", () => {
  test("compiled: the binary re-executes itself with the sentinel first", () => {
    const spawn = selfSpawn("connector", ["github"], COMPILED_POSIX);
    expect(spawn.command).toBe("/opt/nimbus/nimbus-gateway");
    expect(spawn.args).toEqual(["__nimbus-connector", "github"]);
  });

  test("dev: bun runs the gateway entry, then the sentinel", () => {
    const spawn = selfSpawn("connector", ["github"], DEV);
    expect(spawn.command).toBe("/usr/local/bin/bun");
    expect(spawn.args).toEqual([
      "/repo/packages/gateway/src/index.ts",
      "__nimbus-connector",
      "github",
    ]);
  });

  test("the child sees the same argv.slice(2) in both shapes", () => {
    const compiled = selfSpawn("sandbox", ["bun", "x.ts"], COMPILED_POSIX);
    const dev = selfSpawn("sandbox", ["bun", "x.ts"], DEV);
    // argv is [execPath-ish, entry..., ...args]; the child slices 2 off process.argv, and in the
    // compiled shape bun injects its own argv[0]/argv[1] pair. Both therefore start at the sentinel.
    expect(compiled.args).toEqual(["__nimbus-sandbox", "bun", "x.ts"]);
    expect(dev.args.slice(1)).toEqual(["__nimbus-sandbox", "bun", "x.ts"]);
  });

  test("defaults to no role arguments", () => {
    expect(selfSpawn("sandbox", undefined, COMPILED_POSIX).args).toEqual(["__nimbus-sandbox"]);
  });

  test("the two sentinels are distinct and namespaced", () => {
    expect(ROLE_SENTINELS.sandbox).not.toBe(ROLE_SENTINELS.connector);
    for (const s of Object.values(ROLE_SENTINELS)) {
      expect(s.startsWith("__nimbus-")).toBe(true);
    }
  });
});

describe("DEFAULT_RUNTIME_LAYOUT", () => {
  test("points gatewayEntry at the gateway's own index.ts", () => {
    expect(DEFAULT_RUNTIME_LAYOUT.gatewayEntry).toMatch(/index\.ts$/);
    expect(DEFAULT_RUNTIME_LAYOUT.execPath).toBe(process.execPath);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/gateway/src/platform/runtime-layout.test.ts`
Expected: FAIL — `Cannot find module './runtime-layout.ts'`.

- [ ] **Step 3: Write the implementation**

Create `packages/gateway/src/platform/runtime-layout.ts`:

```typescript
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The roles the gateway executable can be invoked in, selected by `process.argv[2]`.
 *
 * A compiled binary ships alone: it has no `bun` on PATH and no source tree beside it, so the only
 * thing it can spawn is itself. Every child process the gateway starts therefore re-executes this
 * same executable with one of these sentinels.
 */
export const ROLE_SENTINELS = {
  sandbox: "__nimbus-sandbox",
  connector: "__nimbus-connector",
} as const;

export type SelfRole = keyof typeof ROLE_SENTINELS;

export interface RuntimeLayout {
  /** `process.execPath`: the bun binary in a dev tree, the gateway binary when compiled. */
  readonly execPath: string;
  /** The directory this module reports living in (`import.meta.dir`). */
  readonly moduleDir: string;
  /** Absolute path to `packages/gateway/src/index.ts`. Only used in a dev tree. */
  readonly gatewayEntry: string;
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_RUNTIME_LAYOUT: RuntimeLayout = {
  execPath: process.execPath,
  moduleDir: MODULE_DIR,
  gatewayEntry: resolve(MODULE_DIR, "..", "index.ts"),
};

/**
 * True when running inside a `bun build --compile` executable.
 *
 * Measured values of `import.meta.dir` there: `/$bunfs/root` on POSIX and `B:\~BUN\root` on
 * Windows. Both are virtual roots — walking up from them yields paths that do not exist, which is
 * why every source-relative asset and script path in the gateway breaks in a released binary.
 */
export function isCompiledBinary(layout: RuntimeLayout = DEFAULT_RUNTIME_LAYOUT): boolean {
  const dir = layout.moduleDir.replaceAll("\\", "/");
  return dir.startsWith("/$bunfs/") || /^[A-Za-z]:\/~BUN\//.test(dir);
}

/**
 * Build the `command` + `args` that re-execute THIS program in one of its non-gateway roles.
 *
 * The child sees the same `process.argv.slice(2)` in both runtime shapes: compiled, bun injects its
 * own argv[0]/argv[1] pair ahead of the user arguments; in a dev tree the gateway entry script
 * occupies argv[1]. Callers therefore never branch on the runtime shape.
 */
export function selfSpawn(
  role: SelfRole,
  args: readonly string[] = [],
  layout: RuntimeLayout = DEFAULT_RUNTIME_LAYOUT,
): { command: string; args: string[] } {
  const sentinel = ROLE_SENTINELS[role];
  return isCompiledBinary(layout)
    ? { command: layout.execPath, args: [sentinel, ...args] }
    : { command: layout.execPath, args: [layout.gatewayEntry, sentinel, ...args] };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/gateway/src/platform/runtime-layout.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/platform/runtime-layout.ts packages/gateway/src/platform/runtime-layout.test.ts
git commit -m "feat(gateway): add runtime-layout, the single compiled-vs-dev seam"
```

---

### Task 2: Connector entry contract — export `startConnector`, and enforce it

Ten connectors guard startup with `if (import.meta.main)`, which is **false when the module is
imported by a registry**. Measured: all ten load, start nothing and exit 0 in silence. The guard
cannot simply be deleted — those ten are the only entrypoints a test can import, and their tests do
import them (`snowflake/test/server-list-pagination.test.ts:3`).

**Files:**

- Modify: `packages/mcp-connectors/argocd/src/server.ts:135-137`
- Modify: `packages/mcp-connectors/bigeye/src/server.ts:136-139`
- Modify: `packages/mcp-connectors/flux/src/server.ts:159-161`
- Modify: `packages/mcp-connectors/looker/src/server.ts:229-232`
- Modify: `packages/mcp-connectors/mlflow/src/server.ts:144-146`
- Modify: `packages/mcp-connectors/monte-carlo/src/server.ts:216-219`
- Modify: `packages/mcp-connectors/powerbi/src/server.ts:224-227`
- Modify: `packages/mcp-connectors/snowflake/src/server.ts:211-214`
- Modify: `packages/mcp-connectors/tableau/src/server.ts:223-226`
- Modify: `packages/mcp-connectors/workday/src/server.ts:74-76`
- Create: `scripts/structure-audit/check-connector-entrypoints.ts`
- Create: `scripts/structure-audit/check-connector-entrypoints.test.ts`
- Modify: `package.json`
- Modify: `scripts/lib/preflight-gates.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: each of the ten modules exports `startConnector(): Promise<void>`. Task 4's
  `run-bundled-connector.ts` calls it. The audit exports
  `checkConnectorEntrypoints(dir?): EntrypointViolation[]` where
  `EntrypointViolation = { connector: string; reason: string }`.

- [ ] **Step 1: Write the failing audit test**

Create `scripts/structure-audit/check-connector-entrypoints.test.ts`:

```typescript
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkConnectorEntrypoints } from "./check-connector-entrypoints.ts";

const ROOT = mkdtempSync(join(tmpdir(), "nimbus-entrypoint-audit-"));

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function fixture(name: string, serverSource: string): void {
  const dir = join(ROOT, name, "src");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "server.ts"), serverSource);
}

fixture(
  "good-guarded",
  `export async function startConnector(): Promise<void> {}\nif (import.meta.main) await startConnector();\n`,
);
fixture("good-unguarded", `await server.connect(transport);\n`);
fixture("bad-guarded", `if (import.meta.main) {\n  await runReadOnlyMcpConnector("x", reg);\n}\n`);

describe("checkConnectorEntrypoints", () => {
  test("flags a guarded entrypoint that does not export startConnector", () => {
    const v = checkConnectorEntrypoints(ROOT);
    expect(v.map((e) => e.connector)).toEqual(["bad-guarded"]);
    expect(v[0]?.reason).toContain("startConnector");
  });

  test("accepts a guarded entrypoint that exports startConnector", () => {
    expect(checkConnectorEntrypoints(ROOT).map((e) => e.connector)).not.toContain("good-guarded");
  });

  test("ignores an unguarded entrypoint entirely", () => {
    expect(checkConnectorEntrypoints(ROOT).map((e) => e.connector)).not.toContain("good-unguarded");
  });

  test("the real connector tree is clean", () => {
    expect(checkConnectorEntrypoints()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test scripts/structure-audit/check-connector-entrypoints.test.ts`
Expected: FAIL — `Cannot find module './check-connector-entrypoints.ts'`.

- [ ] **Step 3: Write the audit**

Create `scripts/structure-audit/check-connector-entrypoints.ts`:

```typescript
#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { stripComments } from "./lib.ts";

export const CONNECTORS_DIR = resolve(import.meta.dir, "..", "..", "packages", "mcp-connectors");

export interface EntrypointViolation {
  readonly connector: string;
  readonly reason: string;
}

const GUARD_RE = /\bimport\.meta\.main\b/;
const EXPORT_RE = /export\s+async\s+function\s+startConnector\s*\(/;

/**
 * A connector `server.ts` that guards its startup with `import.meta.main` is invisible to the
 * bundled-connector registry: the guard is false under an import, so the module loads, starts
 * nothing and the process exits 0 in silence. Such a module MUST export `startConnector()` so the
 * registry can start it explicitly.
 */
export function checkConnectorEntrypoints(dir: string = CONNECTORS_DIR): EntrypointViolation[] {
  const out: EntrypointViolation[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const server = join(dir, entry.name, "src", "server.ts");
    if (!existsSync(server)) continue;
    const src = stripComments(readFileSync(server, "utf8"));
    if (!GUARD_RE.test(src)) continue;
    if (EXPORT_RE.test(src)) continue;
    out.push({
      connector: entry.name,
      reason:
        "guards startup with import.meta.main but does not export startConnector(): the bundled " +
        "registry would import it, start nothing, and exit 0 in silence",
    });
  }
  return out;
}

if (import.meta.main) {
  const violations = checkConnectorEntrypoints();
  for (const v of violations) {
    console.error(
      `::error file=packages/mcp-connectors/${v.connector}/src/server.ts::${v.reason}`,
    );
  }
  console.log(
    violations.length === 0
      ? "connector entrypoints: ok"
      : `connector entrypoints: ${violations.length} violation(s)`,
  );
  process.exit(violations.length > 0 ? 1 : 0);
}
```

- [ ] **Step 4: Run the test — three fixture tests pass, the real-tree test fails**

Run: `bun test scripts/structure-audit/check-connector-entrypoints.test.ts`
Expected: 3 PASS, 1 FAIL. The failure lists all ten real connectors — this is the red-prove that the
audit detects the live defect, not just fixtures.

- [ ] **Step 5: Convert the ten connectors**

Run this codemod from the repo root:

```bash
cat > /tmp/convert-entrypoints.ts <<'EOF'
import { readFileSync, writeFileSync } from "node:fs";

const IDS = ["argocd","bigeye","flux","looker","mlflow","monte-carlo","powerbi","snowflake","tableau","workday"];
const GUARD = /if \(import\.meta\.main\) \{\r?\n(\s*)await (runReadOnlyMcpConnector\([^;]*?\));\r?\n\}/;

for (const id of IDS) {
  const path = `packages/mcp-connectors/${id}/src/server.ts`;
  const src = readFileSync(path, "utf8");
  const m = GUARD.exec(src);
  if (m === null) throw new Error(`${id}: guard block not found — convert by hand`);
  const call = m[2] as string;
  const replacement =
    `export async function startConnector(): Promise<void> {\n  await ${call};\n}\n\n` +
    `if (import.meta.main) await startConnector();`;
  writeFileSync(path, src.replace(GUARD, replacement));
  console.log(`converted ${id}`);
}
EOF
bun /tmp/convert-entrypoints.ts
```

Expected: ten `converted …` lines. `snowflake/src/server.ts` should now end:

```typescript
export async function startConnector(): Promise<void> {
  await runReadOnlyMcpConnector("nimbus-snowflake", registerSnowflakeTools);
}

if (import.meta.main) await startConnector();
```

- [ ] **Step 6: Run the test to verify all four pass**

Run: `bun test scripts/structure-audit/check-connector-entrypoints.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 7: Verify the ten connectors still work standalone and their tests still pass**

```bash
bun test packages/mcp-connectors/snowflake packages/mcp-connectors/argocd packages/mcp-connectors/looker
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"p","version":"0"}}}' | bun packages/mcp-connectors/snowflake/src/server.ts | head -c 200
```

Expected: tests PASS, and the second command prints a JSON line containing
`"serverInfo":{"name":"nimbus-snowflake"`.

- [ ] **Step 8: Wire the audit into the gate set**

In `package.json` `scripts`, next to `"audit:invariants"`:

```json
"audit:connector-entrypoints": "bun scripts/structure-audit/check-connector-entrypoints.ts",
```

In `scripts/lib/preflight-gates.ts`, in the `FAST` array after the `audit:invariants` entry:

```typescript
  {
    // A connector that guards startup with `import.meta.main` is invisible to the bundled
    // registry: the guard is false under an import, so it loads, starts nothing and exits 0.
    // Ten connectors were in exactly that state before this gate existed.
    name: "audit:connector-entrypoints",
    cmd: ["bun", "run", "audit:connector-entrypoints"],
    tier: "fast",
  },
```

- [ ] **Step 9: Verify the gate runs and the manifest drift test is satisfied**

```bash
bun run audit:connector-entrypoints
bun test scripts/lib
```

Expected: `connector entrypoints: ok`, exit 0; the preflight-gates drift test passes.

- [ ] **Step 10: Commit**

```bash
git add packages/mcp-connectors/*/src/server.ts scripts/structure-audit/check-connector-entrypoints.ts scripts/structure-audit/check-connector-entrypoints.test.ts package.json scripts/lib/preflight-gates.ts
git commit -m "fix(connectors): export startConnector from the ten guarded entrypoints"
```

---

### Task 3: Connector dependency allowlist audit

A connector adding a native dependency would break the compiled gateway silently — visible only as a
failed sync on a user's machine. Measured today: the union across all 94 is pure JavaScript.

**Files:**

- Create: `scripts/structure-audit/check-connector-deps.ts`
- Create: `scripts/structure-audit/check-connector-deps.test.ts`
- Modify: `package.json`
- Modify: `scripts/lib/preflight-gates.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `checkConnectorDeps(dir?): DepViolation[]` where
  `DepViolation = { connector: string; dependency: string }`; `ALLOWED_CONNECTOR_DEPS: readonly string[]`.

- [ ] **Step 1: Write the failing test**

Create `scripts/structure-audit/check-connector-deps.test.ts`:

```typescript
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ALLOWED_CONNECTOR_DEPS, checkConnectorDeps } from "./check-connector-deps.ts";

const ROOT = mkdtempSync(join(tmpdir(), "nimbus-connector-deps-"));

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function fixture(name: string, dependencies: Record<string, string>): void {
  const dir = join(ROOT, name);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "server.ts"), "// entry\n");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, dependencies }));
}

fixture("clean", { zod: "^4.0.0", "@nimbus-dev/sdk": "^1.8.1" });
fixture("native", { "better-sqlite3": "^11.0.0" });

describe("checkConnectorDeps", () => {
  test("flags a dependency outside the allowlist", () => {
    const v = checkConnectorDeps(ROOT);
    expect(v).toEqual([{ connector: "native", dependency: "better-sqlite3" }]);
  });

  test("accepts allowlisted dependencies", () => {
    expect(checkConnectorDeps(ROOT).map((e) => e.connector)).not.toContain("clean");
  });

  test("the real connector tree is clean", () => {
    expect(checkConnectorDeps()).toEqual([]);
  });

  test("the allowlist stays small and deliberate", () => {
    expect(ALLOWED_CONNECTOR_DEPS.length).toBeLessThanOrEqual(10);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test scripts/structure-audit/check-connector-deps.test.ts`
Expected: FAIL — `Cannot find module './check-connector-deps.ts'`.

- [ ] **Step 3: Write the audit**

Create `scripts/structure-audit/check-connector-deps.ts`:

```typescript
#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const CONNECTORS_DIR = resolve(import.meta.dir, "..", "..", "packages", "mcp-connectors");

/**
 * Runtime dependencies a first-party connector may declare. Every connector is bundled into the
 * gateway binary, so a native (node-gyp / prebuilt `.node`) dependency would either fail the
 * compile or produce a binary that cannot load its shared library at runtime — and the only symptom
 * a user sees is a sync that never works. Keep this list pure JavaScript.
 */
export const ALLOWED_CONNECTOR_DEPS: readonly string[] = [
  "@modelcontextprotocol/sdk",
  "@nimbus-dev/sdk",
  "zod",
  "hyparquet",
  "imapflow",
  "nodemailer",
  "tsdav",
];

export interface DepViolation {
  readonly connector: string;
  readonly dependency: string;
}

export function checkConnectorDeps(dir: string = CONNECTORS_DIR): DepViolation[] {
  const allowed = new Set(ALLOWED_CONNECTOR_DEPS);
  const out: DepViolation[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgPath = join(dir, entry.name, "package.json");
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      if (!allowed.has(dep)) out.push({ connector: entry.name, dependency: dep });
    }
  }
  return out;
}

if (import.meta.main) {
  const violations = checkConnectorDeps();
  for (const v of violations) {
    console.error(
      `::error file=packages/mcp-connectors/${v.connector}/package.json::dependency "${v.dependency}" is not in ALLOWED_CONNECTOR_DEPS — connectors are bundled into the gateway binary, so a native dependency breaks it silently`,
    );
  }
  console.log(
    violations.length === 0
      ? "connector deps: ok"
      : `connector deps: ${violations.length} violation(s)`,
  );
  process.exit(violations.length > 0 ? 1 : 0);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test scripts/structure-audit/check-connector-deps.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Wire the audit into the gate set**

In `package.json` `scripts`:

```json
"audit:connector-deps": "bun scripts/structure-audit/check-connector-deps.ts",
```

In `scripts/lib/preflight-gates.ts`, in `FAST` immediately after the `audit:connector-entrypoints`
entry:

```typescript
  {
    // Connectors are bundled into the gateway binary. A native dependency would break the
    // compile or the runtime load, and the only symptom is a sync that never works.
    name: "audit:connector-deps",
    cmd: ["bun", "run", "audit:connector-deps"],
    tier: "fast",
  },
```

- [ ] **Step 6: Verify**

```bash
bun run audit:connector-deps
bun test scripts/lib
```

Expected: `connector deps: ok`, exit 0; drift test passes.

- [ ] **Step 7: Commit**

```bash
git add scripts/structure-audit/check-connector-deps.ts scripts/structure-audit/check-connector-deps.test.ts package.json scripts/lib/preflight-gates.ts
git commit -m "feat(ci): gate connector runtime dependencies against an allowlist"
```

---

### Task 4: Bundled connector registry and its runner

**Files:**

- Create: `scripts/gen-bundled-connector-registry.ts`
- Create: `packages/gateway/src/connectors/bundled-connector-registry.ts` (generated)
- Create: `packages/gateway/src/connectors/bundled-connector-registry.test.ts`
- Create: `packages/gateway/src/connectors/run-bundled-connector.ts`
- Create: `packages/gateway/src/connectors/run-bundled-connector.test.ts`
- Modify: `scripts/coverage-floor/exclusions.ts`
- Modify: `package.json`

**Interfaces:**

- Consumes: Task 2's `startConnector` export.
- Produces: `BUNDLED_CONNECTORS: Readonly<Record<string, () => Promise<unknown>>>` and
  `runBundledConnector(id: string | undefined, registry?): Promise<void>`. Task 5's shim calls
  `runBundledConnector`.

- [ ] **Step 1: Write the generator**

Create `scripts/gen-bundled-connector-registry.ts`:

```typescript
#!/usr/bin/env bun
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const CONNECTORS_DIR = join(REPO_ROOT, "packages", "mcp-connectors");
const OUT = join(
  REPO_ROOT,
  "packages",
  "gateway",
  "src",
  "connectors",
  "bundled-connector-registry.ts",
);

export function bundledConnectorIds(dir: string = CONNECTORS_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "src", "server.ts")))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

function render(ids: readonly string[]): string {
  const entries = ids
    .map((id) => `  ${JSON.stringify(id)}: () => import("../../../mcp-connectors/${id}/src/server.ts"),`)
    .join("\n");
  return `// GENERATED by scripts/gen-bundled-connector-registry.ts — do not edit by hand.
// Re-run: bun run gen:connector-registry
//
// Every first-party connector entrypoint, as a lazy dynamic import. The imports are static enough
// for the bundler to retain all ${ids.length} in the compiled gateway binary, and lazy enough that
// only the requested connector is ever evaluated.

export const BUNDLED_CONNECTORS: Readonly<Record<string, () => Promise<unknown>>> = {
${entries}
};
`;
}

if (import.meta.main) {
  const ids = bundledConnectorIds();
  writeFileSync(OUT, render(ids));
  console.log(`wrote ${OUT} with ${ids.length} connectors`);
}
```

- [ ] **Step 2: Generate the registry and register the script**

```bash
bun scripts/gen-bundled-connector-registry.ts
head -12 packages/gateway/src/connectors/bundled-connector-registry.ts
```

Expected: `wrote … with 94 connectors`, and the head shows the banner followed by the first entry:

```typescript
  "airflow": () => import("../../../mcp-connectors/airflow/src/server.ts"),
```

In `package.json` `scripts`:

```json
"gen:connector-registry": "bun scripts/gen-bundled-connector-registry.ts",
```

- [ ] **Step 3: Write the failing drift test**

Create `packages/gateway/src/connectors/bundled-connector-registry.test.ts`. It re-derives the id
set from disk **independently** of the generator, so a stale generated file is caught:

```typescript
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { BUNDLED_CONNECTORS } from "./bundled-connector-registry.ts";

const CONNECTORS_DIR = resolve(import.meta.dir, "..", "..", "..", "mcp-connectors");

/** Derived here rather than imported, so this test disagrees with a stale generated file. */
function idsOnDisk(): string[] {
  return readdirSync(CONNECTORS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(CONNECTORS_DIR, e.name, "src", "server.ts")))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

describe("BUNDLED_CONNECTORS", () => {
  test("contains exactly the connector packages that have an entrypoint", () => {
    const registered = Object.keys(BUNDLED_CONNECTORS).sort((a, b) => a.localeCompare(b));
    expect(registered).toEqual(idsOnDisk());
  });

  test("covers every connector — a shrinking registry is the drift this guards", () => {
    expect(Object.keys(BUNDLED_CONNECTORS).length).toBeGreaterThanOrEqual(94);
  });

  test("every entry is a lazy loader, not an eagerly evaluated module", () => {
    for (const [id, load] of Object.entries(BUNDLED_CONNECTORS)) {
      expect(typeof load, `${id} must be a function`).toBe("function");
    }
  });
});
```

- [ ] **Step 4: Run the drift test**

Run: `bun test packages/gateway/src/connectors/bundled-connector-registry.test.ts`
Expected: PASS, 3 tests. If it fails with a mismatch, re-run `bun run gen:connector-registry`.

- [ ] **Step 5: Write the failing runner test**

Create `packages/gateway/src/connectors/run-bundled-connector.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";

import { runBundledConnector } from "./run-bundled-connector.ts";

describe("runBundledConnector", () => {
  test("calls startConnector when the module exports one", async () => {
    let started = 0;
    await runBundledConnector("guarded", {
      guarded: () => Promise.resolve({ startConnector: async () => { started += 1; } }),
    });
    expect(started).toBe(1);
  });

  test("resolves for a module that starts on import and exports nothing", async () => {
    let imported = 0;
    await runBundledConnector("unguarded", {
      unguarded: () => { imported += 1; return Promise.resolve({}); },
    });
    expect(imported).toBe(1);
  });

  test("rejects an unknown id and names the known ones", async () => {
    await expect(
      runBundledConnector("nope", { alpha: () => Promise.resolve({}), beta: () => Promise.resolve({}) }),
    ).rejects.toThrow(/unknown connector id "nope".*alpha, beta/s);
  });

  test("rejects a missing id rather than defaulting to one", async () => {
    await expect(runBundledConnector(undefined, { alpha: () => Promise.resolve({}) })).rejects.toThrow(
      /unknown connector id/,
    );
  });

  test("propagates a failure from the connector's own startup", async () => {
    await expect(
      runBundledConnector("boom", {
        boom: () => Promise.resolve({ startConnector: () => Promise.reject(new Error("no token")) }),
      }),
    ).rejects.toThrow("no token");
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `bun test packages/gateway/src/connectors/run-bundled-connector.test.ts`
Expected: FAIL — `Cannot find module './run-bundled-connector.ts'`.

- [ ] **Step 7: Write the runner**

Create `packages/gateway/src/connectors/run-bundled-connector.ts`:

```typescript
import { BUNDLED_CONNECTORS } from "./bundled-connector-registry.ts";

/** The two shapes a connector entrypoint can take. See docs/superpowers/specs for why both exist. */
interface ConnectorModule {
  readonly startConnector?: () => Promise<void>;
}

export type ConnectorRegistry = Readonly<Record<string, () => Promise<unknown>>>;

/**
 * Run one bundled connector in-process, as the `__nimbus-connector` role of the gateway executable.
 *
 * 84 connectors connect their stdio transport at module scope, so importing them starts them. Ten
 * guard that behind `import.meta.main` — false under an import — and export `startConnector()`
 * instead. Calling it when present covers both without the caller knowing which shape it got.
 */
export async function runBundledConnector(
  id: string | undefined,
  registry: ConnectorRegistry = BUNDLED_CONNECTORS,
): Promise<void> {
  const load = id === undefined ? undefined : registry[id];
  if (load === undefined) {
    const known = Object.keys(registry)
      .sort((a, b) => a.localeCompare(b))
      .join(", ");
    throw new Error(`unknown connector id ${JSON.stringify(id ?? "")}; known ids: ${known}`);
  }
  const mod = (await load()) as ConnectorModule;
  if (typeof mod.startConnector === "function") {
    await mod.startConnector();
  }
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `bun test packages/gateway/src/connectors/run-bundled-connector.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 9: Exclude the generated registry from the coverage floor**

The registry is 94 arrow functions that no unit test calls; without this the per-file floor (≥85%
line) fails on a generated data module. In `scripts/coverage-floor/exclusions.ts`, add an entry in
the existing `{ kind: "exact", path: … }` form — put it next to the
`packages/gateway/src/connectors/lazy-mesh/slot.ts` line (around line 219):

```typescript
  // Generated by scripts/gen-bundled-connector-registry.ts: 94 lazy `() => import(...)` thunks and
  // no logic. Executing one starts a real MCP server on stdio, so unit tests cannot call them; the
  // all-connector boot smoke (scripts/connector-boot-smoke.ts) covers every entry instead.
  { kind: "exact", path: "packages/gateway/src/connectors/bundled-connector-registry.ts" },
```

No second edit is needed: `check-exclusion-parity.ts` is one-directional — it asserts every
`sonar.coverage.exclusions` pattern is covered by `isExempt`, not the reverse.

Verify with `bun test scripts/coverage-floor`.

- [ ] **Step 10: Verify types and lint**

```bash
bun run typecheck
bun run lint
```

Expected: both exit 0.

- [ ] **Step 11: Commit**

```bash
git add scripts/gen-bundled-connector-registry.ts packages/gateway/src/connectors/bundled-connector-registry.ts packages/gateway/src/connectors/bundled-connector-registry.test.ts packages/gateway/src/connectors/run-bundled-connector.ts packages/gateway/src/connectors/run-bundled-connector.test.ts scripts/coverage-floor/exclusions.ts package.json
git commit -m "feat(gateway): add the bundled connector registry and its runner"
```

---

### Task 5: The thin entry shim

Dispatching inside today's `index.ts` would prevent the `createPlatformServices()` call but not
module **evaluation**: `connectors/registry.ts:8`, `engine/run-ask.ts:21` and
`index/sqlite-vec-load.ts:7` construct pino loggers at module scope, and `Config` freezes every
`NIMBUS_*` variable at first import. So the shim must reach each role through a **dynamic** import.

**Files:**

- Create: `packages/gateway/src/gateway-main.ts` (from today's `index.ts`)
- Rewrite: `packages/gateway/src/index.ts`
- Modify: `packages/gateway/src/platform/sandbox/sandbox-wrapper.ts`
- Create: `packages/gateway/src/entry-graph.test.ts`

**Interfaces:**

- Consumes: Task 1's `ROLE_SENTINELS`, Task 4's `runBundledConnector`.
- Produces: `gateway-main.ts` exports `main(): Promise<void>`; `sandbox-wrapper.ts` exports
  `runSandboxWrapper(args: readonly string[]): Promise<never>`. Task 6 consumes neither directly.

- [ ] **Step 1: Move the gateway body into `gateway-main.ts`**

```bash
git mv packages/gateway/src/index.ts packages/gateway/src/gateway-main.ts
```

Then in `gateway-main.ts`, change `async function main(): Promise<void> {` (line 41) to
`export async function main(): Promise<void> {`, and delete the trailing block:

```typescript
try {
  await main();
} catch (err: unknown) {
  emergencyGatewayLog(err);
  console.error("[gateway] fatal:", err);
  process.exit(1);
}
```

Also delete the now-unused `emergencyGatewayLog` import from `gateway-main.ts` — it moves to the
shim.

- [ ] **Step 2: Make the sandbox wrapper callable**

In `packages/gateway/src/platform/sandbox/sandbox-wrapper.ts`, change the signature and the argument
source, and drop the top-level invocation:

```typescript
export async function runSandboxWrapper(args: readonly string[]): Promise<never> {
  if (args.length < 1) {
    fatal("usage: <gateway> __nimbus-sandbox <cmd> [...args]");
  }
  const originalCmd = args[0];
```

The rest of the function body is unchanged. Delete the `const args = process.argv.slice(2);` line
(it is now the parameter) and delete the final `await main();` line. Remove the `#!/usr/bin/env bun`
shebang — the file is no longer an entrypoint.

- [ ] **Step 3: Write the new shim**

Create `packages/gateway/src/index.ts`:

```typescript
#!/usr/bin/env bun
import { ROLE_SENTINELS } from "./platform/runtime-layout.ts";

/**
 * The gateway executable has three roles, selected by argv[2]. A compiled binary ships alone — no
 * bun on PATH, no source tree beside it — so the only program it can spawn is itself.
 *
 * This file stays THIN on purpose. Each role is reached through a dynamic import so that a
 * connector role never evaluates the gateway module graph, which builds loggers and freezes config
 * at import time. `entry-graph.test.ts` enforces that.
 */
const sentinel = process.argv[2];
const roleArgs = process.argv.slice(3);

function failRole(message: string): never {
  process.stderr.write(`nimbus-gateway: ${message}\n`);
  process.exit(2);
}

if (sentinel === ROLE_SENTINELS.sandbox) {
  const { runSandboxWrapper } = await import("./platform/sandbox/sandbox-wrapper.ts");
  await runSandboxWrapper(roleArgs);
} else if (sentinel === ROLE_SENTINELS.connector) {
  const { runBundledConnector } = await import("./connectors/run-bundled-connector.ts");
  try {
    await runBundledConnector(roleArgs[0]);
  } catch (err: unknown) {
    failRole(err instanceof Error ? err.message : String(err));
  }
} else {
  const { main } = await import("./gateway-main.ts");
  try {
    await main();
  } catch (err: unknown) {
    const { emergencyGatewayLog } = await import("./platform/gateway-log-file.ts");
    emergencyGatewayLog(err);
    console.error("[gateway] fatal:", err);
    process.exit(1);
  }
}
```

- [ ] **Step 4: Write the import-graph test**

Create `packages/gateway/src/entry-graph.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const SRC = import.meta.dir;

/** Value imports only — `import type` is erased and cannot cause module evaluation. */
const FROM_RE = /^\s*import\s+(?!type\b)[^;]*?from\s+"(\.[^"]+)"/gm;
/** Bare side-effect imports: `import "./x.ts";` */
const BARE_RE = /^\s*import\s+"(\.[^"]+)"/gm;

function staticDepsOf(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const re of [FROM_RE, BARE_RE]) {
    re.lastIndex = 0;
    for (const m of src.matchAll(re)) out.push(resolve(dirname(file), m[1] as string));
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

describe("the entry shim", () => {
  test("statically imports exactly one module — the runtime layout", () => {
    expect(staticDepsOf(resolve(SRC, "index.ts"))).toEqual([
      resolve(SRC, "platform", "runtime-layout.ts"),
    ]);
  });

  test("the connector role never reaches db/, vault/ or ipc/", () => {
    const graph = [...transitiveStaticGraph(resolve(SRC, "connectors", "run-bundled-connector.ts"))];
    expect(graph.filter((f) => STATEFUL.test(f))).toEqual([]);
  });

  // Red-prove: without this, a walker that silently resolves nothing would make the assertion
  // above pass vacuously. The gateway role MUST reach the stateful modules.
  test("the walker really does traverse — the gateway role reaches db/vault/ipc", () => {
    const graph = [...transitiveStaticGraph(resolve(SRC, "gateway-main.ts"))];
    expect(graph.length).toBeGreaterThan(20);
    expect(graph.some((f) => STATEFUL.test(f))).toBe(true);
  });
});
```

- [ ] **Step 5: Run the tests**

Run: `bun test packages/gateway/src/entry-graph.test.ts`
Expected: PASS, 3 tests. If test 2 fails, the registry or runner is pulling in a stateful module —
fix the import, do not relax the assertion.

- [ ] **Step 6: Verify all three roles work in the dev tree**

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"p","version":"0"}}}' | GITHUB_TOKEN=dummy bun packages/gateway/src/index.ts __nimbus-connector github | head -c 160
bun packages/gateway/src/index.ts __nimbus-connector nope; echo "exit=$?"
```

Expected: the first prints `"serverInfo":{"name":"nimbus-github"`; the second prints
`nimbus-gateway: unknown connector id "nope"; known ids: airflow, apple, …` and `exit=2`.

- [ ] **Step 7: Verify types, lint and the gateway's own test suite**

```bash
bun run typecheck
bun run lint
bun test packages/gateway/src
```

Expected: all exit 0. Verified in advance: **no test imports the gateway entry module**, so the
`git mv` breaks no import. (`graph-populator-branches.test.ts:644` contains the string
`"src/index.ts"` as fixture metadata, not an import.) If a new one appears, point it at
`../gateway-main.ts` rather than re-exporting `main` from the shim — re-exporting would put the
gateway graph back into the shim's static imports and fail `entry-graph.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add packages/gateway/src/index.ts packages/gateway/src/gateway-main.ts packages/gateway/src/entry-graph.test.ts packages/gateway/src/platform/sandbox/sandbox-wrapper.ts
git commit -m "refactor(gateway): make index.ts a thin argv shim with dynamic role imports"
```

---

### Task 6: Migrate the 82 spawn sites

**Files:**

- Modify: `packages/gateway/src/connectors/lazy-mesh/keys.ts:1-10`
- Modify: `packages/gateway/src/connectors/lazy-mesh/connector-spawns.ts` (31 sites)
- Modify: `packages/gateway/src/connectors/lazy-mesh/phase3-config.ts` (49 sites)
- Modify: `packages/gateway/src/connectors/lazy-mesh/chatops-bot-spawn.ts` (2 sites)
- Modify: `packages/gateway/src/connectors/lazy-mesh/wrap-server-spec.ts`
- Modify: `packages/gateway/src/connectors/lazy-mesh/wrap-server-spec.test.ts`

**Interfaces:**

- Consumes: Task 1's `selfSpawn`.
- Produces: `connectorSpawn(packageDir: string): { command: string; args: string[] }` from `keys.ts`.
  `MCP_CONNECTORS_ROOT`, `mcpConnectorServerScript` and `SANDBOX_WRAPPER_PATH` cease to exist.

- [ ] **Step 1: Replace the path helper in `keys.ts`**

Replace lines 1–10 of `packages/gateway/src/connectors/lazy-mesh/keys.ts` with:

```typescript
import { selfSpawn } from "../../platform/runtime-layout.ts";

/**
 * The command+args that run a first-party connector. In a dev tree this is
 * `bun <gateway>/src/index.ts __nimbus-connector <pkg>`; in a compiled binary it is the binary
 * re-executing itself. It is never `bun <path-into-the-source-tree>` — a released binary ships
 * with neither bun nor that tree.
 */
export function connectorSpawn(packageDir: string): { command: string; args: string[] } {
  return selfSpawn("connector", [packageDir]);
}
```

The `LAZY_MESH` map and the `USER_MESH_PREFIX` / `userMcpMeshKey` exports below are unchanged.

- [ ] **Step 2: Run the codemod over the three spawn files**

```bash
cat > /tmp/migrate-spawns.ts <<'EOF'
import { readFileSync, writeFileSync } from "node:fs";

const FILES = [
  "packages/gateway/src/connectors/lazy-mesh/connector-spawns.ts",
  "packages/gateway/src/connectors/lazy-mesh/phase3-config.ts",
  "packages/gateway/src/connectors/lazy-mesh/chatops-bot-spawn.ts",
];
const SITE = /command: "bun",\r?\n\s*args: \[mcpConnectorServerScript\("([^"]+)"\)\],/g;

let total = 0;
for (const file of FILES) {
  const src = readFileSync(file, "utf8");
  let count = 0;
  const next = src
    .replace(SITE, (_m, pkg: string) => { count += 1; return `...connectorSpawn(${JSON.stringify(pkg)}),`; })
    .replace(/\bmcpConnectorServerScript\b/g, "connectorSpawn");
  writeFileSync(file, next);
  console.log(`${file}: ${count} sites`);
  total += count;
}
console.log(`total: ${total}`);
EOF
bun /tmp/migrate-spawns.ts
```

Expected output:

```text
packages/gateway/src/connectors/lazy-mesh/connector-spawns.ts: 31 sites
packages/gateway/src/connectors/lazy-mesh/phase3-config.ts: 49 sites
packages/gateway/src/connectors/lazy-mesh/chatops-bot-spawn.ts: 2 sites
total: 82
```

A site that read:

```typescript
      googleServers["gmail"] = wrap(
        {
          command: "bun",
          args: [mcpConnectorServerScript("gmail")],
          env: extensionProcessEnv({ GOOGLE_OAUTH_ACCESS_TOKEN: token }),
        },
```

now reads:

```typescript
      googleServers["gmail"] = wrap(
        {
          ...connectorSpawn("gmail"),
          env: extensionProcessEnv({ GOOGLE_OAUTH_ACCESS_TOKEN: token }),
        },
```

- [ ] **Step 3: Verify no spawn site survives**

```bash
grep -rn 'command: "bun"' packages/gateway/src/connectors/lazy-mesh/ | grep -v "\.test\.ts"; echo "sites-left=$?"
grep -rn "mcpConnectorServerScript\|MCP_CONNECTORS_ROOT" packages/gateway/src --include=*.ts | grep -v "\.test\.ts"; echo "helper-left=$?"
```

Expected: both print nothing and `=1` (grep found no matches). Any surviving line is a site the
regex missed — convert it by hand.

- [ ] **Step 4: Rewrite `wrapServerSpec` to go through `selfSpawn`**

Replace `packages/gateway/src/connectors/lazy-mesh/wrap-server-spec.ts` entirely:

```typescript
import type { ExtensionManifest } from "../../extensions/manifest.ts";
import { selfSpawn } from "../../platform/runtime-layout.ts";
import type { ServerSpec } from "./slot.ts";

/**
 * I15: every connector ServerSpec passes through here, so the sandbox is not optional. The wrapper
 * runs as the `__nimbus-sandbox` role of this same executable — previously it was
 * `process.execPath` plus a path to sandbox-wrapper.ts, which does not exist in a compiled binary.
 */
export function wrapServerSpec(
  spec: ServerSpec,
  manifest: ExtensionManifest,
  cwd: string,
): ServerSpec {
  const { command, args } = selfSpawn("sandbox", [spec.command, ...spec.args]);
  return {
    command,
    args,
    env: {
      ...spec.env,
      NIMBUS_SANDBOX_MANIFEST_JSON: JSON.stringify(manifest),
      NIMBUS_SANDBOX_CWD: cwd,
    },
  };
}
```

- [ ] **Step 5: Update `wrap-server-spec.test.ts` for the new argv shape**

Change the import on line 8 to drop `SANDBOX_WRAPPER_PATH`:

```typescript
import { wrapServerSpec } from "./wrap-server-spec.ts";
```

Replace the `"args[0] is the sandbox-wrapper path"` and `"preserves the original command + args
after the wrapper path"` tests with these two, and delete the whole trailing
`describe("SANDBOX_WRAPPER_PATH", …)` block:

```typescript
  test("args lead with the gateway entry and the sandbox sentinel (dev tree)", () => {
    const wrapped = wrapServerSpec(makeSpec(), makeManifest(), CWD);
    expect(wrapped.args[0]).toMatch(/[\\/]packages[\\/]gateway[\\/]src[\\/]index\.ts$/);
    expect(wrapped.args[1]).toBe("__nimbus-sandbox");
  });

  test("preserves the original command + args after the sentinel", () => {
    const wrapped = wrapServerSpec(makeSpec(), makeManifest(), CWD);
    expect(wrapped.args[2]).toBe("bun");
    expect(wrapped.args[3]).toBe("packages/mcp-connectors/github/src/server.ts");
    expect(wrapped.args[4]).toBe("--mode");
    expect(wrapped.args[5]).toBe("stdio");
  });
```

- [ ] **Step 6: Run the affected tests**

```bash
bun test packages/gateway/src/connectors
bun run typecheck
```

Expected: PASS and exit 0. Checked in advance: `wrap-server-spec.test.ts` is the **only** test that
asserts wrapped spawn arguments by index. The other `args[N]` assertions under
`packages/gateway/src/connectors/` are in `athena-sync.test.ts` and concern AWS CLI arguments, and
`lazy-mesh-args-json.test.ts` builds its own `/bin/echo` specs for user-MCP health cases — neither
is affected.

- [ ] **Step 7: Verify I15 and the static audits still hold**

```bash
bun run audit:invariants
bun run audit:cross-platform
```

Expected: both exit 0. `audit:invariants` proves D10/I15 is intact — every spec still passes through
`wrapServerSpec()`.

- [ ] **Step 8: Commit**

```bash
git add packages/gateway/src/connectors/lazy-mesh/
git commit -m "refactor(connectors): spawn connectors via the gateway's own executable"
```

---

### Task 7: The all-connector boot smoke

The gate that makes the headline claim testable. Run once during design, it found the ten-connector
silent-failure class that Task 2 fixes.

**Files:**

- Create: `scripts/connector-boot-smoke.ts`
- Modify: `package.json`
- Modify: `scripts/lib/preflight-gates.ts`
- Modify: `.github/workflows/_test-suite.yml`

**Interfaces:**

- Consumes: Task 4's `BUNDLED_CONNECTORS`, Task 5's `__nimbus-connector` role.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the smoke script**

Create `scripts/connector-boot-smoke.ts`:

```typescript
#!/usr/bin/env bun
import { BUNDLED_CONNECTORS } from "../packages/gateway/src/connectors/bundled-connector-registry.ts";

/**
 * Boot every bundled connector out of a compiled gateway binary and demand it does something
 * observable. A connector may legitimately refuse to start without credentials — that is a non-zero
 * exit with a message. What it may NOT do is exit 0 in silence or hang, which is what a connector
 * whose startup is unreachable from the registry looks like.
 */
const BINARY = process.argv[2];
const TIMEOUT_MS = 15_000;
const CONCURRENCY = 8;

if (BINARY === undefined) {
  console.error("usage: bun scripts/connector-boot-smoke.ts <path-to-nimbus-gateway>");
  process.exit(2);
}

const INITIALIZE = `${JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "boot-smoke", version: "0" },
  },
})}\n`;

type Outcome =
  | { id: string; ok: true; how: "answered" | "refused" }
  | { id: string; ok: false; why: string };

async function boot(id: string): Promise<Outcome> {
  const proc = Bun.spawn([BINARY as string, "__nimbus-connector", id], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(INITIALIZE);
  await proc.stdin.flush();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, TIMEOUT_MS);

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);

  if (stdout.includes('"serverInfo"')) return { id, ok: true, how: "answered" };
  if (timedOut) return { id, ok: false, why: `hung for ${TIMEOUT_MS}ms without answering` };
  if (code !== 0 && stderr.trim() !== "") {
    return { id, ok: true, how: "refused" };
  }
  return {
    id,
    ok: false,
    why: `exited ${String(code)} with no serverInfo and no error — its startup is unreachable from the registry`,
  };
}

const ids = Object.keys(BUNDLED_CONNECTORS).sort((a, b) => a.localeCompare(b));
const results: Outcome[] = [];
for (let i = 0; i < ids.length; i += CONCURRENCY) {
  results.push(...(await Promise.all(ids.slice(i, i + CONCURRENCY).map(boot))));
}

const failures = results.filter((r): r is Extract<Outcome, { ok: false }> => !r.ok);
const answered = results.filter((r) => r.ok && r.how === "answered").length;
const refused = results.filter((r) => r.ok && r.how === "refused").length;

console.log(
  `connector boot smoke: ${String(results.length)} connectors — ${String(answered)} answered, ${String(refused)} refused without credentials, ${String(failures.length)} failed`,
);
for (const f of failures) {
  console.error(`::error::connector ${f.id}: ${f.why}`);
}
process.exit(failures.length > 0 ? 1 : 0);
```

- [ ] **Step 2: Build a gateway binary and run the smoke**

Use the same command CI uses (`_test-suite.yml:766`) rather than `packages/gateway`'s `build`
script, which additionally rotates the running binary and copies the vec0 sidecar:

```bash
(cd packages/gateway && bun build src/index.ts --compile --outfile ../../dist/nimbus-gateway --target bun)
bun scripts/connector-boot-smoke.ts dist/nimbus-gateway
echo "exit=$?"
```

Expected: `connector boot smoke: 94 connectors — 89 answered, 5 refused without credentials, 0
failed` and `exit=0`. The five refusals are the IMAP-family connectors (`apple`, `fastmail`, `imap`,
`obsidian`, `protonmail`), which throw `Error: <VAR> is not set` from `requireProcessEnv` — correct
behaviour, identical in a dev tree.

- [ ] **Step 3: Red-prove the smoke**

Temporarily re-break one connector to confirm the gate actually catches the class it exists for:

```bash
git stash push packages/mcp-connectors/snowflake/src/server.ts
(cd packages/gateway && bun build src/index.ts --compile --outfile ../../dist/nimbus-gateway --target bun)
bun scripts/connector-boot-smoke.ts dist/nimbus-gateway; echo "exit=$?"
git stash pop
```

Expected: `exit=1` and an error line naming `snowflake` with "its startup is unreachable from the
registry". Rebuild afterwards so the binary matches the tree.

- [ ] **Step 4: Register the script and the gate**

In `package.json` `scripts`:

```json
"test:connector-boot": "bun scripts/connector-boot-smoke.ts dist/nimbus-gateway",
```

In `scripts/lib/preflight-gates.ts`, in the `FULL` array (it needs a compiled binary, so it does not
belong in `fast`):

```typescript
  {
    // Proves the headline claim: an installed binary can actually start every connector it ships.
    // Requires `dist/nimbus-gateway` to exist — the full tier builds it.
    name: "test:connector-boot",
    cmd: ["bun", "run", "test:connector-boot"],
    tier: "full",
  },
```

- [ ] **Step 5: Wire it into CI**

In `.github/workflows/_test-suite.yml`, in the job that already compiles both binaries (the step at
line 766–767), add a step immediately after the build:

```yaml
      - name: Connector boot smoke — every bundled connector starts
        shell: bash
        run: bun scripts/connector-boot-smoke.ts dist/nimbus-gateway
```

- [ ] **Step 6: Verify the gate manifest drift test**

```bash
bun test scripts/lib
bun run preflight:fast
```

Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add scripts/connector-boot-smoke.ts package.json scripts/lib/preflight-gates.ts .github/workflows/_test-suite.yml
git commit -m "test(connectors): gate that every bundled connector actually starts"
```

---

## Final verification before opening the PR

- [ ] **Full preflight**

```bash
bun run preflight > /tmp/preflight.log 2>&1; echo "exit=$?"; tail -40 /tmp/preflight.log
```

Check the **exit code**, not the tail. A piped command hides the status, and an early failure in
this suite stops later gates from running at all — a green-looking tail with a non-zero exit means
gates never ran.

- [ ] **Prove the end-to-end claim on a compiled binary, outside the checkout**

```bash
STAGE=$(mktemp -d)
cp dist/nimbus-gateway* "$STAGE/"
cd "$STAGE"
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"p","version":"0"}}}' | GITHUB_TOKEN=dummy ./nimbus-gateway __nimbus-connector github | head -c 160
cd -
```

Expected: `"serverInfo":{"name":"nimbus-github"` printed from a binary with no source tree and no
`bun` anywhere near it. This is the defect this PR exists to fix; confirm it directly.

- [ ] **Confirm the binary size delta is still ~4%**

```bash
ls -l dist/nimbus-gateway*
```

Expected: roughly 98 MB. A materially larger number means something unintended entered the build
graph — investigate before opening the PR.

## Out of scope for this PR

Embedded assets (`/admin`, the OpenAPI document), the console build wiring and the vec0 release step
are PR 2. The `install-smoke.yml` assertions, the documentation subtraction pass and the
status-drift scanner extension are PR 3. Neither is blocked by this one beyond the shim existing.

**Deliberately deferred to PR 2: the `import.meta.dir` confinement audit.** The spec puts a static
rule around runtime path derivation, confining it to `runtime-layout.ts`. It cannot land here,
because two of its violations are only removed in PR 2 — `ipc/http-server.ts:190` (the OpenAPI
document) and `ipc/admin-console-assets.ts:35` (the console dist). Landing the rule now would mean
shipping it with two exemptions and then remembering to delete them, which is how allowlists become
permanent. It lands in PR 2 with an empty allowlist apart from `perf/surfaces/*` and tests.
