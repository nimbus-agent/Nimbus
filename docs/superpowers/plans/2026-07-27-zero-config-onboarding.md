# Zero-config Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `nimbus why` work immediately after install with no credentials, no API key, and no config editing.

**Architecture:** The zero-config path already exists — `synthesize.ts:81` returns a deterministic render when no LLM is configured, and filesystem indexing needs no credentials. This plan exposes it: a config-dir override so the flow is testable, an append-only writer for `nimbus.toml`, an index-driven picker for the demo `file:line`, a `nimbus init` command wiring those together, honest no-LLM messaging, and an e2e test that *is* the funnel.

**Tech Stack:** Bun 1.2+, TypeScript 6.x strict, `bun:test`, `bun:sqlite`, Biome.

## Global Constraints

- **No `any`** — use `unknown` for external data. TypeScript strict is non-negotiable.
- **Cross-platform paths** — always `path.join()` / `os.tmpdir()`, never hardcoded separators. `bun run audit:cross-platform` flags Windows-separator assertions.
- **Never commit on `main`** — work on a `dev/<you>/<topic>` branch.
- **Gateway imports nothing from cli/ui.** The CLI reaches the gateway over IPC only.
- **No new runtime dependencies.** Specifically: do **not** add a TOML serializer.
- **No telemetry.** Nothing added by this plan may phone home.
- **Verify before pushing:** `bun run preflight:fast` after any change; scoped `bun test <path>` when logic or tests are touched.
- **Biome inside a worktree:** `bun run lint` reports 0 files under `.claude/worktrees/`. Validate with `bunx biome check packages scripts`.

---

### Task 1: `NIMBUS_CONFIG_DIR` override

Without this the e2e test in Task 6 cannot isolate. `createDarwinPaths()` reads `homedir()` with **no env seam at all**, so on macOS a test would silently use the developer's real config directory.

**Files:**
- Modify: `packages/gateway/src/platform/paths.ts`
- Test: `packages/gateway/src/platform/paths.test.ts`

**Interfaces:**
- Consumes: `processEnvGet` from `./env-access.ts`; existing `PlatformPaths` type.
- Produces: all three of `createWindowsPaths()`, `createDarwinPaths()`, `createLinuxPaths()` honour `NIMBUS_CONFIG_DIR` for the `configDir` field only. Other fields are unchanged.

- [ ] **Step 1: Write the failing test**

Add to `packages/gateway/src/platform/paths.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { createDarwinPaths, createLinuxPaths, createWindowsPaths } from "./paths.ts";

describe("NIMBUS_CONFIG_DIR override", () => {
  afterEach(() => {
    delete process.env["NIMBUS_CONFIG_DIR"];
  });

  test("overrides configDir on every platform creator", () => {
    process.env["NIMBUS_CONFIG_DIR"] = "/tmp/nimbus-test-config";
    process.env["APPDATA"] ??= "C:\\Users\\test\\AppData\\Roaming";
    process.env["LOCALAPPDATA"] ??= "C:\\Users\\test\\AppData\\Local";

    expect(createWindowsPaths().configDir).toBe("/tmp/nimbus-test-config");
    expect(createDarwinPaths().configDir).toBe("/tmp/nimbus-test-config");
    expect(createLinuxPaths().configDir).toBe("/tmp/nimbus-test-config");
  });

  test("leaves dataDir alone — only configDir is overridden", () => {
    process.env["NIMBUS_CONFIG_DIR"] = "/tmp/nimbus-test-config";
    const before = createLinuxPaths().dataDir;
    delete process.env["NIMBUS_CONFIG_DIR"];
    expect(createLinuxPaths().dataDir).toBe(before);
  });

  test("absent override leaves the platform default intact", () => {
    delete process.env["NIMBUS_CONFIG_DIR"];
    expect(createLinuxPaths().configDir).not.toBe("/tmp/nimbus-test-config");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/gateway/src/platform/paths.test.ts`
Expected: FAIL — `createDarwinPaths().configDir` returns the real `~/Library/Application Support/Nimbus`.

- [ ] **Step 3: Implement the override**

In `packages/gateway/src/platform/paths.ts`, add above `createWindowsPaths`:

```ts
/**
 * Test/CI seam for relocating the config directory.
 *
 * Exists because `createDarwinPaths()` reads `homedir()` with no env input at
 * all, so without this an isolated test on macOS would read and write the
 * developer's real config. Only `configDir` moves — `dataDir` and the socket
 * path deliberately do not, so this cannot silently repoint a live gateway's
 * database.
 */
function configDirOverride(): string | undefined {
  const v = processEnvGet("NIMBUS_CONFIG_DIR");
  return v !== undefined && v.length > 0 ? v : undefined;
}
```

Then in each of the three creators, replace the `configDir` value in the returned object with `configDirOverride() ?? <existing expression>`. For Windows the existing expression is `join(appData, "Nimbus")`; for darwin it is `root`; for Linux it is `join(configRoot, "nimbus")`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/gateway/src/platform/paths.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/platform/paths.ts packages/gateway/src/platform/paths.test.ts
git commit -m "feat(platform): add NIMBUS_CONFIG_DIR override for configDir"
```

---

### Task 2: Append-only `[[filesystem.roots]]` writer (CLI-side)

`nimbus init` is the first code anywhere to write `nimbus.toml`. Appending — never rewriting — structurally removes comment-stripping and key-reordering.

**This lives in the CLI, not the gateway.** Config authoring is a client concern, the gateway never writes config, and **the CLI may not import gateway source** (IPC only). That boundary also means this module cannot reuse `parseNimbusTomlFilesystemRoots`; its already-present check must be self-contained, which is why `hasFilesystemRoot` is scoped narrowly to exactly that question.

**Files:**
- Create: `packages/cli/src/commands/_lib/toml-append.ts`
- Create: `packages/cli/src/commands/_lib/toml-append.test.ts`

**Interfaces:**
- Consumes: `node:fs`, `node:path` only. No gateway imports.
- Produces:
  - `hasFilesystemRoot(source: string, rootPath: string): boolean`
  - `appendFilesystemRoot(configDir: string, rootPath: string): AppendRootResult`, where `type AppendRootResult = { status: "added" | "already-present"; tomlPath: string; backupPath?: string }`

  Task 3 consumes both.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/commands/_lib/toml-append.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendFilesystemRoot, hasFilesystemRoot } from "./toml-append.ts";

let dir: string;

beforeEach(() => {
  dir = join(tmpdir(), `nimbus-toml-write-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(dir, { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("creates nimbus.toml when absent and adds the root", () => {
  const res = appendFilesystemRoot(dir, "/repo/a");
  expect(res.status).toBe("added");
  const written = readFileSync(res.tomlPath, "utf8");
  expect(written).toContain("[[filesystem.roots]]");
  expect(written).toContain("code_index = true");
  expect(hasFilesystemRoot(written, "/repo/a")).toBe(true);
});

test("hasFilesystemRoot ignores a commented-out root", () => {
  // A commented block must not make init think it is already configured.
  expect(hasFilesystemRoot('# path = "/repo/a"\n', "/repo/a")).toBe(false);
});

test("preserves comments, formatting, and unrelated sections verbatim", () => {
  // The whole reason this is append-only: a parse/serialize cycle would lose these.
  const original = ['# my notes', '', '[llm]', 'prefer_local = true  # keep me', ''].join("\n");
  writeFileSync(join(dir, "nimbus.toml"), original, "utf8");

  appendFilesystemRoot(dir, "/repo/a");

  const after = readFileSync(join(dir, "nimbus.toml"), "utf8");
  expect(after.startsWith(original)).toBe(true);
  expect(after).toContain("# my notes");
  expect(after).toContain("prefer_local = true  # keep me");
});

test("is idempotent — a second call reports already-present and does not duplicate", () => {
  appendFilesystemRoot(dir, "/repo/a");
  const second = appendFilesystemRoot(dir, "/repo/a");
  expect(second.status).toBe("already-present");
  const written = readFileSync(second.tomlPath, "utf8");
  expect(written.split("[[filesystem.roots]]").length - 1).toBe(1);
});

test("writes a .bak before modifying an existing file", () => {
  writeFileSync(join(dir, "nimbus.toml"), "# original\n", "utf8");
  const res = appendFilesystemRoot(dir, "/repo/a");
  expect(res.backupPath).toBe(join(dir, "nimbus.toml.bak"));
  expect(readFileSync(join(dir, "nimbus.toml.bak"), "utf8")).toBe("# original\n");
});

test("no backup is written when the file did not exist", () => {
  const res = appendFilesystemRoot(dir, "/repo/a");
  expect(res.backupPath).toBeUndefined();
  expect(existsSync(join(dir, "nimbus.toml.bak"))).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/cli/src/commands/_lib/toml-append.test.ts`
Expected: FAIL — cannot resolve `./toml-append.ts`.

- [ ] **Step 3: Implement the writer**

Create `packages/cli/src/commands/_lib/toml-append.ts`:

```ts
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type AppendRootResult = {
  status: "added" | "already-present";
  tomlPath: string;
  backupPath?: string;
};

/**
 * Is `rootPath` already configured as a filesystem root in this TOML source?
 *
 * Deliberately narrow. The CLI cannot import the gateway's TOML parser (IPC-only
 * boundary), so this answers exactly one question rather than pretending to be a
 * parser. Comments are stripped first so a commented-out example root does not
 * make `init` believe it has already run.
 */
export function hasFilesystemRoot(source: string, rootPath: string): boolean {
  const target = resolve(rootPath);
  return source.split(/\r?\n/).some((line) => {
    const hash = line.indexOf("#");
    const code = (hash < 0 ? line : line.slice(0, hash)).trim();
    if (!code.startsWith("path")) return false;
    const eq = code.indexOf("=");
    if (eq <= 0) return false;
    const raw = code.slice(eq + 1).trim();
    if (raw.length < 2) return false;
    const unquoted = raw.slice(1, -1);
    return resolve(unquoted) === target;
  });
}

/**
 * Add a `[[filesystem.roots]]` block to nimbus.toml by APPENDING.
 *
 * Append-only on purpose. Config parsing in the gateway is a bespoke section
 * scanner, not a round-trippable TOML library, so there is no serializer to
 * write back through — and a parse/serialize cycle would strip the user's
 * comments and reorder their keys. Appending cannot do either.
 */
export function appendFilesystemRoot(configDir: string, rootPath: string): AppendRootResult {
  const tomlPath = join(configDir, "nimbus.toml");
  const target = resolve(rootPath);

  if (existsSync(tomlPath) && hasFilesystemRoot(readFileSync(tomlPath, "utf8"), target)) {
    return { status: "already-present", tomlPath };
  }

  mkdirSync(configDir, { recursive: true });

  let backupPath: string | undefined;
  let prefix = "";
  if (existsSync(tomlPath)) {
    backupPath = `${tomlPath}.bak`;
    copyFileSync(tomlPath, backupPath);
    const current = readFileSync(tomlPath, "utf8");
    prefix = current.endsWith("\n") || current === "" ? "" : "\n";
  }

  // JSON.stringify gives correct TOML escaping for a basic string.
  const block = [
    "",
    "[[filesystem.roots]]",
    `path = ${JSON.stringify(target)}`,
    "git_aware = true",
    "code_index = true",
    "",
  ].join("\n");

  writeFileSync(tomlPath, prefix + block, { encoding: "utf8", flag: "a" });
  return backupPath === undefined
    ? { status: "added", tomlPath }
    : { status: "added", tomlPath, backupPath };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/cli/src/commands/_lib/toml-append.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/_lib/toml-append.ts packages/cli/src/commands/_lib/toml-append.test.ts
git commit -m "feat(cli): append-only writer for [[filesystem.roots]]"
```

---

### Task 3: Pick the demo `file:line` from the index

Selecting by file extension can land on a lockfile or something unindexed. `nimbus why` resolves a *symbol in the index*, so query the index instead — a lockfile never becomes a symbol.

**Files:**
- Create: `packages/gateway/src/agents/_lib/demo-symbol.ts`
- Create: `packages/gateway/src/agents/_lib/demo-symbol.test.ts`

**Interfaces:**
- Consumes: `Database` from `bun:sqlite`; the `graph_entity` + `item` schema used by `why-subject.ts`.
- Produces: `pickDemoSymbol(db: Database, repoRoot: string): DemoSymbol | null` where `type DemoSymbol = { file: string; line: number; name: string }`.

> **Boundary note — read before starting.** This is gateway-side, and **the CLI cannot import it** (IPC only). So `nimbus init` cannot call it directly; reaching it needs a small read-only IPC method (Step 5 below), which is genuine added surface: a method, a runtime validator, and a Tauri-allowlist decision. Consult the `nimbus-ipc` skill first.
>
> If that surface is judged not worth it, the acceptable fallback is for `nimbus init` to print a generic next step (`nimbus why <file>:<line>`) and for this task to ship as an internal improvement only. **Decide before implementing** — do not leave `init` promising a concrete `file:line` it cannot produce.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/agents/_lib/demo-symbol.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
import { pickDemoSymbol } from "./demo-symbol.ts";

let db: Database;

function seedSymbol(id: string, file: string, repoRoot: string, name: string, line: number): void {
  db.run("INSERT INTO item (id, metadata) VALUES (?, ?)", [
    id,
    JSON.stringify({ excerptStartLine: line }),
  ]);
  db.run("INSERT INTO graph_entity (external_id, type, label, metadata) VALUES (?, ?, ?, ?)", [
    id,
    "symbol",
    name,
    JSON.stringify({ file, repoRoot, name }),
  ]);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.run("CREATE TABLE item (id TEXT PRIMARY KEY, metadata TEXT)");
  db.run(
    "CREATE TABLE graph_entity (id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT, type TEXT, label TEXT, metadata TEXT)",
  );
});

test("returns a symbol under the requested repo root", () => {
  seedSymbol("i1", "/repo/src/auth.ts", "/repo", "verifyToken", 42);
  expect(pickDemoSymbol(db, "/repo")).toEqual({
    file: "/repo/src/auth.ts",
    line: 42,
    name: "verifyToken",
  });
});

test("ignores symbols belonging to a different repo root", () => {
  seedSymbol("i1", "/other/src/x.ts", "/other", "somethingElse", 7);
  expect(pickDemoSymbol(db, "/repo")).toBeNull();
});

test("skips a symbol with no usable start line rather than returning line 0", () => {
  db.run("INSERT INTO item (id, metadata) VALUES ('i1', ?)", [JSON.stringify({})]);
  db.run("INSERT INTO graph_entity (external_id, type, label, metadata) VALUES (?,?,?,?)", [
    "i1",
    "symbol",
    "noLine",
    JSON.stringify({ file: "/repo/a.ts", repoRoot: "/repo", name: "noLine" }),
  ]);
  seedSymbol("i2", "/repo/b.ts", "/repo", "hasLine", 10);
  expect(pickDemoSymbol(db, "/repo")?.name).toBe("hasLine");
});

test("returns null on an empty index instead of throwing", () => {
  expect(pickDemoSymbol(db, "/repo")).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/gateway/src/agents/_lib/demo-symbol.test.ts`
Expected: FAIL — cannot resolve `./demo-symbol.ts`.

- [ ] **Step 3: Implement the picker**

Create `packages/gateway/src/agents/_lib/demo-symbol.ts`:

```ts
import type { Database } from "bun:sqlite";

export type DemoSymbol = { file: string; line: number; name: string };

/**
 * Pick a symbol to show off `nimbus why` after a first sync.
 *
 * Queries the index rather than the filesystem: `nimbus why` resolves symbols,
 * so anything this returns is guaranteed resolvable. A lockfile, a config file,
 * or a binary asset can never be selected because none of them become symbols.
 * Shorter labels first, so the suggestion is a plain function name rather than
 * a deeply-qualified one.
 */
export function pickDemoSymbol(db: Database, repoRoot: string): DemoSymbol | null {
  const row = db
    .query(
      `SELECT json_extract(e.metadata, '$.file') AS file,
              json_extract(e.metadata, '$.name') AS name,
              CAST(json_extract(i.metadata, '$.excerptStartLine') AS INTEGER) AS start_line
         FROM graph_entity e
         JOIN item i ON i.id = e.external_id
        WHERE e.type = 'symbol'
          AND json_extract(e.metadata, '$.repoRoot') = ?
          AND json_extract(e.metadata, '$.file') IS NOT NULL
          AND start_line IS NOT NULL
          AND start_line > 0
        ORDER BY length(e.label) ASC, e.id ASC
        LIMIT 1`,
    )
    .get(repoRoot) as { file?: string; name?: string; start_line?: number } | null;

  if (row?.file === undefined || row.file === null) return null;
  if (row.start_line === undefined || row.start_line === null) return null;
  return { file: row.file, line: row.start_line, name: row.name ?? "symbol" };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/gateway/src/agents/_lib/demo-symbol.test.ts`
Expected: PASS (4 tests)

If `start_line` cannot be referenced in `WHERE` on this SQLite build, repeat the `CAST(json_extract(...))` expression inline in both predicates instead of using the alias.

- [ ] **Step 5: Expose it, or record the fallback**

Per the boundary note above, either:

- **(a)** add a read-only IPC method returning `DemoSymbol | null` for a given root — following the `nimbus-ipc` skill for naming, the runtime validator, and the Tauri-allowlist decision (a read-only index query is renderer-safe, but the decision must be explicit); or
- **(b)** record in the task's commit message that `init` prints a generic next step, and that this picker is currently unused by the CLI.

Do not skip this step silently.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/agents/_lib/demo-symbol.ts packages/gateway/src/agents/_lib/demo-symbol.test.ts
git commit -m "feat(agents): pick the demo why-subject from the index"
```

---

### Task 4: `nimbus init` command

**Files:**
- Create: `packages/cli/src/commands/init.ts`
- Create: `packages/cli/src/commands/init.test.ts`
- Modify: `packages/cli/src/index.ts` (add to `COMMAND_HANDLERS`)
- Modify: `packages/cli/src/commands/registry.ts` (add to `COMMAND_NAMES`)

**Interfaces:**
- Consumes: `appendFilesystemRoot`, `hasFilesystemRoot`, `AppendRootResult` from `./_lib/toml-append.ts` (Task 2, CLI-side — no gateway import); `getCliPlatformPaths()` from `../paths.ts`.
- Produces: `initPlan(opts: InitOptions): InitPlan` and `runInit(args: string[]): Promise<void>`, registered as `init`.

`initPlan` is a pure decision function so the behaviour is testable without touching disk; `runInit` performs the effects.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/commands/init.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initPlan } from "./init.ts";

let dir: string;

beforeEach(() => {
  dir = join(tmpdir(), `nimbus-init-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(join(dir, "repo", ".git"), { recursive: true });
  mkdirSync(join(dir, "config"), { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("plans an add when the cwd is a git repo not yet configured", () => {
  const plan = initPlan({ cwd: join(dir, "repo"), configDir: join(dir, "config") });
  expect(plan.kind).toBe("add-root");
});

test("refuses when the cwd is not a git repository", () => {
  const plan = initPlan({ cwd: dir, configDir: join(dir, "config") });
  expect(plan.kind).toBe("not-a-repo");
});

test("reports already-configured on a second run", () => {
  const opts = { cwd: join(dir, "repo"), configDir: join(dir, "config") };
  applyInitPlan(initPlan(opts), opts);
  expect(initPlan(opts).kind).toBe("already-configured");
});
```

Add `applyInitPlan` to the import line once Step 3 defines it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/cli/src/commands/init.test.ts`
Expected: FAIL — cannot resolve `./init.ts`.

- [ ] **Step 3: Implement the command**

Create `packages/cli/src/commands/init.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { appendFilesystemRoot, hasFilesystemRoot } from "./_lib/toml-append.ts";

export type InitOptions = { cwd: string; configDir: string };
export type InitPlan =
  | { kind: "add-root"; repoRoot: string }
  | { kind: "already-configured"; repoRoot: string }
  | { kind: "not-a-repo" };

/** Pure decision step, so the behaviour is testable without touching disk. */
export function initPlan(opts: InitOptions): InitPlan {
  const repoRoot = resolve(opts.cwd);
  if (!existsSync(join(repoRoot, ".git"))) return { kind: "not-a-repo" };

  const tomlPath = join(opts.configDir, "nimbus.toml");
  if (existsSync(tomlPath) && hasFilesystemRoot(readFileSync(tomlPath, "utf8"), repoRoot)) {
    return { kind: "already-configured", repoRoot };
  }
  return { kind: "add-root", repoRoot };
}

/** Effects only. The append-only + backup contract lives in toml-append.ts. */
export function applyInitPlan(plan: InitPlan, opts: InitOptions): void {
  if (plan.kind !== "add-root") return;
  appendFilesystemRoot(opts.configDir, plan.repoRoot);
}

export async function runInit(_args: string[]): Promise<void> {
  const { getCliPlatformPaths } = await import("../paths.ts");
  const paths = getCliPlatformPaths();
  const opts: InitOptions = { cwd: process.cwd(), configDir: paths.configDir };
  const plan = initPlan(opts);

  if (plan.kind === "not-a-repo") {
    console.error("nimbus init: run this inside a git repository.");
    process.exitCode = 1;
    return;
  }
  if (plan.kind === "already-configured") {
    console.log(`Already configured: ${plan.repoRoot}`);
    return;
  }
  applyInitPlan(plan, opts);
  console.log(`Added ${plan.repoRoot} to nimbus.toml (code indexing on).`);
  console.log("Next: nimbus connector sync filesystem   # then: nimbus why <file>:<line>");
}
```

- [ ] **Step 4: Register the command**

In `packages/cli/src/index.ts`, import `runInit` alongside the other command imports and add to `COMMAND_HANDLERS`:

```ts
  init: runInit,
```

In `packages/cli/src/commands/registry.ts`, add `"init"` to the `COMMAND_NAMES` array. **This is required** — `audit:readme-cli` fails when a documented `nimbus <cmd>` is missing from that registry.

- [ ] **Step 5: Run the tests and the registry audit**

Run: `bun test packages/cli/src/commands/init.test.ts && bun run audit:readme-cli`
Expected: PASS, and `audit:readme-cli: OK`

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/init.ts packages/cli/src/commands/init.test.ts packages/cli/src/index.ts packages/cli/src/commands/registry.ts
git commit -m "feat(cli): add nimbus init for zero-config onboarding"
```

---

### Task 5: Honest no-LLM messaging

**Files:**
- Modify: `packages/gateway/src/agents/_lib/synthesize.ts`
- Modify: `packages/gateway/src/agents/_lib/synthesize.test.ts`

**Interfaces:**
- Consumes: existing `synthesize(brief, opts)`.
- Produces: unchanged signature. When `opts.llm === undefined`, the returned Markdown gains a trailing footer line.

- [ ] **Step 1: Write the failing test**

Add to `packages/gateway/src/agents/_lib/synthesize.test.ts`:

```ts
test("no-LLM output is labelled as a deliberate mode, not silent degradation", async () => {
  const brief = { kind: "why", findings: [] } as unknown as Parameters<typeof synthesize>[0];
  const out = await synthesize(brief);
  expect(out).toContain("Rendered deterministically");
});

test("an LLM-backed render carries no such footer", async () => {
  const brief = { kind: "why", findings: [] } as unknown as Parameters<typeof synthesize>[0];
  const out = await synthesize(brief, { llm: { generateMarkdown: async () => "# polished" } });
  expect(out).not.toContain("Rendered deterministically");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/gateway/src/agents/_lib/synthesize.test.ts`
Expected: FAIL — footer absent.

- [ ] **Step 3: Implement the footer**

In `synthesize.ts`, replace the early return at line 81:

```ts
  if (opts.llm === undefined) return withDeterministicFooter(deterministic);
```

and add near `deterministicRender`:

```ts
const DETERMINISTIC_FOOTER =
  "_Rendered deterministically — configure an LLM for prose synthesis._";

/**
 * Label the no-LLM path so it reads as a supported mode rather than breakage.
 * The fallback branches (empty / throwing LLM) deliberately do NOT get this
 * footer: there the user HAS configured an LLM, and claiming otherwise would be
 * misleading.
 */
function withDeterministicFooter(markdown: string): string {
  return `${markdown.trimEnd()}\n\n${DETERMINISTIC_FOOTER}\n`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/gateway/src/agents/_lib/synthesize.test.ts`
Expected: PASS

- [ ] **Step 5: Make `nimbus ask` fail helpfully**

`ask` genuinely needs an LLM — unlike `why`, it cannot degrade. Find where `packages/cli/src/commands/ask.ts` surfaces a gateway error and add a targeted branch so an unconfigured LLM prints guidance instead of a raw error:

```ts
// `ask` is the one command that truly requires an LLM. Everything else —
// indexing, `why`, the agent briefs — works without one, so the message must
// point at the upgrade rather than implying Nimbus is unusable.
const LLM_SETUP_HELP = [
  "nimbus ask needs an LLM. Two options:",
  "",
  "  Local  — install Ollama, then in nimbus.toml:",
  "             [llm]",
  "             prefer_local = true",
  '             local_model  = "llama3.1"',
  "",
  "  Hosted — set your provider key in nimbus.toml under [llm].",
  "",
  "Indexing, `nimbus why`, and the agent briefs all work with no LLM configured.",
].join("\n");
```

Use the gateway's **existing JSON-RPC numeric error-code convention** to distinguish the case — do not introduce a parallel string-enum scheme. Add a test asserting the guidance is printed and the exit code is non-zero.

- [ ] **Step 6: Run the tests**

Run: `bun test packages/gateway/src/agents/_lib/synthesize.test.ts packages/cli/src/commands/ask.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/agents/_lib/synthesize.ts packages/gateway/src/agents/_lib/synthesize.test.ts packages/cli/src/commands/ask.ts packages/cli/src/commands/ask.test.ts
git commit -m "feat: label the no-LLM mode and make nimbus ask fail with guidance"
```

---

### Task 6: The e2e test that is the funnel

**Files:**
- Create: `packages/cli/test/e2e/zero-config-onboarding.test.ts`

**Interfaces:**
- Consumes: `NIMBUS_CONFIG_DIR` (Task 1), `nimbus init` (Task 4).

- [ ] **Step 1: Write the test**

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root: string;

beforeEach(() => {
  root = join(tmpdir(), `nimbus-funnel-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(join(root, "repo", ".git"), { recursive: true });
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "repo", "auth.ts"), "export function verifyToken() { return true; }\n");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("init works with no credentials and no LLM configured", async () => {
  // Isolation is the point: NIMBUS_CONFIG_DIR keeps this off the developer's
  // real config, and no NIMBUS_OAUTH_*/API key is set. The repo-wide test
  // preload also blanks inherited credentials, so a stray provider key cannot
  // silently satisfy the no-LLM precondition.
  const proc = Bun.spawn(["bun", "run", "packages/cli/src/index.ts", "init"], {
    cwd: join(root, "repo"),
    env: { ...process.env, NIMBUS_CONFIG_DIR: join(root, "config"), NIMBUS_QUIET: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  const out = await new Response(proc.stdout).text();

  expect(code).toBe(0);
  expect(out).toContain("nimbus.toml");
  expect(Bun.file(join(root, "config", "nimbus.toml")).size).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run it**

Run: `bun test packages/cli/test/e2e/zero-config-onboarding.test.ts`
Expected: PASS

- [ ] **Step 3: Verify the gateway boots with no `[llm]` block**

Run the gateway against the same isolated config dir and confirm it starts and answers `gateway.ping`. If it fails, that is open question 1 resolving negatively — fix the config loader to treat `[llm]` as optional before continuing.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/test/e2e/zero-config-onboarding.test.ts
git commit -m "test(e2e): prove init works with no credentials and no LLM"
```

---

### Task 7: README rewrite

**Files:**

- Modify: `README.md`
- Modify: `packages/docs/src/content/docs/user-guide/install.mdx`

- [ ] **Step 1: Rewrite the quickstart**

Replace README Quickstart steps 2 and 3 so step 2 is `nimbus init` inside an existing repo and step 3 is `nimbus why <file>:<line>`. Move the GitHub-PAT connector example below, framed as "connect a cloud service".

- [ ] **Step 2: Cut the LLM gate from the framing**

Delete the sentence **"Nimbus needs an LLM, but it does not require a cloud one."** Replace the "Run it fully offline" section with an "Optional: add an LLM" section stating that indexing, `nimbus why`, and the agent briefs work with no LLM, and that one is needed only for `nimbus ask` and prose synthesis.

- [ ] **Step 3: Run the doc gates**

Run: `bun run lint:markdown && bun run audit:doc-refs && bun run audit:readme-cli`
Expected: all OK

- [ ] **Step 4: Commit**

```bash
git add README.md packages/docs/src/content/docs/user-guide/install.mdx
git commit -m "docs: lead with the zero-config path, demote the LLM to optional"
```

---

## Final verification

- [ ] `bun run preflight:fast`
- [ ] `bunx biome check packages scripts` (worktree-safe lint)
- [ ] `bun test packages/gateway/src packages/cli/src`
- [ ] `bun run audit:cross-platform`
