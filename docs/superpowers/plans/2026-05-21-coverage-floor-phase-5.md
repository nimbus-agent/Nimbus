# Coverage Floor Phase 5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the Gateway long-tail — get the remaining Gateway baseline entries above the 80% per-file line-coverage floor or honestly structurally exclude them. Drop the baseline from 116 → ~94 entries (~22 entries removed: 14 raised + 2 newly structurally excluded + 6 stale housekeeping). After this PR the Gateway baseline is empty.

**Spec:** [`docs/superpowers/specs/2026-05-21-coverage-floor-phase-5-design.md`](../specs/2026-05-21-coverage-floor-phase-5-design.md) (rev 2)
**Design review:** [`docs/superpowers/specs/2026-05-21-coverage-floor-phase-5-design-review.md`](../specs/2026-05-21-coverage-floor-phase-5-design-review.md)
**Plan review:** [`docs/superpowers/plans/2026-05-21-coverage-floor-phase-5-review.md`](./2026-05-21-coverage-floor-phase-5-review.md) (rev 2)

**Architecture:** Single PR with 13 commits ordered low-risk → high-risk: housekeeping first, structural exclusions second, Phase 4 partials third, small-file Tier B nudges fourth, harder Tier B integration tests + Tier C carryover + Tier D retry in the middle, baseline drop + plan/spec/status row last. No new shared harness needed — reuse Phase 2's `connector-sync-harness.ts`, the spawned-server pattern proven by `packages/gateway/test/integration/http/openapi-route.test.ts`, the existing `ink-testing-library` from `App.test.tsx`, and `MockVault` from `@nimbus-dev/sdk/testing`. Tests are colocated next to source files per Phase 3/4 precedent.

**Tech Stack:** Bun v1.2+ test runner, `bun:test`, `bun:sqlite`, `MockVault` from `@nimbus-dev/sdk/testing`, `ink-testing-library`, Biome lint.

**Branch:** `dev/asafgolombek/coverage-floor-phase-5-2026-05-21`
**Worktree:** `.worktrees/coverage-floor-phase-5-2026-05-21/`
**Base commit:** `5e660ecf` (PR #375, Phase 4 merge)

---

## File Map

**Created (test files, colocated):**

- `packages/gateway/src/ipc/http-server.test.ts` (commit 7)
- `packages/gateway/src/ipc/server/socket-listeners.test.ts` (commit 9)
- `packages/gateway/src/platform/paths.test.ts` (commit 4)
- `packages/gateway/src/extensions/registry-fetcher.test.ts` (commit 6)
- `packages/gateway/src/embedding/load-transformer-pipeline.ts` (new source file — commit 12)
- `packages/gateway/src/embedding/model.test.ts` (commit 12)

**Created or extended (test files, already exist for these):**

- `packages/gateway/src/agents/impact.test.ts` (extend — commit 3)
- `packages/gateway/src/db/verify.test.ts` (extend — commit 3)
- `packages/gateway/src/embedding/create-embedding-runtime.test.ts` (extend — commit 3)
- `packages/gateway/src/platform/assemble.test.ts` (extend — commit 3)
- `packages/gateway/src/connectors/filesystem-v2-sync.test.ts` (extend — commit 3)
- `packages/gateway/src/ipc/server/server.test.ts` (extend — commit 8)
- `packages/cli/src/tui/App.test.tsx` (extend — commit 10)
- `packages/cli/src/tui/detect-fallback.test.ts` (extend — commit 5)
- `packages/gateway/src/extensions/install-from-local.test.ts` (extend — commit 11, may split into Tier C-1 + C-2)

**Modified (source code, commit 12 only):**

- `packages/gateway/src/embedding/model.ts` — replace `await import("@xenova/transformers")` with a call to `loadTransformerPipeline()` from the new sibling.

**Modified (registry/config):**

- `scripts/coverage-floor/exclusions.ts` — add 3 entries total: `platform/index.ts` + `vault/factory.ts` (commit 2) + `embedding/load-transformer-pipeline.ts` (commit 12).
- `sonar-project.properties` — mirror the same 3 entries.
- `docs/structure-audit/coverage-baseline.json` — drop 6 stale entries (commit 1), drop 2 newly-excluded entries (commit 2), drop ~14 raised entries + record any partial-raise watermarks (commit 13).
- `CLAUDE.md` + `GEMINI.md` — add status row under "Phase 5 (Extended Surface)" line (commit 13).
- This plan file (`docs/superpowers/plans/2026-05-21-coverage-floor-phase-5.md`).

---

## Pre-implementation guardrails

All Phase 4 carry-forwards apply identically. Repeating here so the implementer doesn't have to cross-reference:

- **CI Linux is authoritative.** Local Windows lcov diverges on a known set of pinned files. Never lower a baseline watermark to match local Windows lcov — only match CI Linux.
- **TS strictness modes that trip during test authoring:**
  - `noUncheckedIndexedAccess` — `arr[i]` is `T | undefined`; use `arr[i]?.field`.
  - `noPropertyAccessFromIndexSignature` — `Record<string, unknown>` needs bracket access `obj["key"]`.
  - `exactOptionalPropertyTypes: true` — pass no property instead of `prop: undefined`.
- `bun:test`'s `test.each(table)` requires a **mutable** array — never `readonly T[]`.
- For `fetch` stubs: closures that throw infer `Promise<never>` and need `as unknown as typeof fetch`; closures that return `Response` use plain `as typeof fetch`.
- `mock.module(...)` is process-global. `scripts/coverage-floor/build-lcov.sh` runs `bun test --coverage` per package — colocated tests AND `test/integration/**/*.test.ts` share that one process. Don't try to use `test/integration/` placement to dodge a mock collision; rename the mock target instead (commit 12 does this).
- IDE false positives to ignore: `await expect(...).rejects.toThrow(...)` "await has no effect", `bun:sqlite` / `bun:test` "declared but never read" on used imports.
- `db.run` / `db.exec` in test files is fine (static auditor skips `*.test.ts`).
- Run `bun run lint:fix` before every commit.
- The plan's per-file case suggestions are *guesses*. Read the source FIRST; target the actual uncovered branches; document divergence in implementer reports.

---

## Test hygiene (cross-cutting rules)

Apply these patterns in any task that mutates global state, env vars, sockets, or subprocess APIs.

### Env-var and global-state restoration

Any task mutating `process.env`, `globalThis`, or any other global **must** restore the original value in `afterEach`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

describe("…", () => {
  const ORIGINAL_ENV = process.env["SOME_VAR"];
  beforeEach(() => {
    process.env["SOME_VAR"] = "test-value";
  });
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env["SOME_VAR"];
    } else {
      process.env["SOME_VAR"] = ORIGINAL_ENV;
    }
  });
});
```

For `globalThis.<prop>` or `process.stdout.<prop>` stubs done via `Object.defineProperty`, capture the original descriptor and restore:

```typescript
let originalIsTtyDescriptor: PropertyDescriptor | undefined;
beforeEach(() => {
  originalIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});
afterEach(() => {
  if (originalIsTtyDescriptor === undefined) {
    delete (process.stdout as unknown as { isTTY?: boolean }).isTTY;
  } else {
    Object.defineProperty(process.stdout, "isTTY", originalIsTtyDescriptor);
  }
});
```

**Applies to:** Task 4 (`platform/paths.ts` — `XDG_*` + `APPDATA` + `LOCALAPPDATA` + `TMPDIR` env stubs), Task 5 (`tui/detect-fallback.ts` — `TERM`/`NO_COLOR`/`CI`/stdout props), Task 6 (`extensions/registry-fetcher.ts` — `fetch` stub), Task 7 (`ipc/http-server.ts` — `http_api.deployment_token` vault key), Task 10 (`tui/App.tsx` — `process.stdout.isTTY/.columns/.rows`), Task 11 (`extensions/install-from-local.ts` — vault + fs).

### Spawned-server `port: 0` pattern

`ipc/http-server.ts` integration tests must use `port: 0` to avoid port-collision flakes on shared CI runners. Pattern from `packages/gateway/test/integration/http/openapi-route.test.ts:21`:

```typescript
import { startReadOnlyHttpServer } from "../../../src/ipc/http-server.ts";
let handle: ReturnType<typeof startReadOnlyHttpServer> | undefined;
let port: number;

beforeEach(() => {
  // ... set up tmpDir + dbPath ...
  handle = startReadOnlyHttpServer(dbPath, 0);
  port = handle.port; // OS-assigned free port
});

afterEach(() => {
  handle?.stop();
});

it("does X", async () => {
  const res = await fetch(`http://127.0.0.1:${port}/v1/...`);
  // ...
});
```

**Applies to:** Task 7 (`ipc/http-server.ts`).

### Tmp-dir unix socket path for `net.createServer`

`socket-listeners.ts`'s `startWin32NetServer` and `startBunUnixListener` accept a `listenPath`. On Linux CI, **pass a unix socket path under tmp dir** — never a `\\.\pipe\…` path (Windows named pipe; silently fails on Linux):

```typescript
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = mkdtempSync(join(tmpdir(), "nimbus-socket-test-"));
const socketPath = join(tmpDir, "nimbus-test.sock");
```

**Applies to:** Task 9 (`ipc/server/socket-listeners.ts`).

### `mock.module` target-renaming for mock-collision avoidance

When a colocated test would otherwise collide with another test's `mock.module(...)` of the same target, **rename the mock target via a sibling indirection module**. Pattern adopted by commit 12:

1. Create a tiny sibling source file (e.g. `embedding/load-transformer-pipeline.ts`) that wraps the real dynamic import.
2. Have the source-under-test call the sibling's exported function instead of `await import("real-module")` directly.
3. The test mocks the **sibling** path (a unique target nothing else mocks).
4. Add the sibling to `EXCLUSIONS` + `sonar-project.properties` in the same commit so it's not flagged for coverage.

**Applies to:** Task 12 (`embedding/model.ts` ↔ `embedding/load-transformer-pipeline.ts`).

---

## Task 0: Worktree verification

The worktree was created out-of-band before this plan was authored. Verify it before starting.

- [ ] **Step 1: Verify worktree state**

```bash
git status
git rev-parse HEAD
git branch --show-current
```

Expected:
- Working directory `c:\gitrep\Nimbus\.worktrees\coverage-floor-phase-5-2026-05-21`
- Branch: `dev/asafgolombek/coverage-floor-phase-5-2026-05-21`
- Three spec/plan/review commits already present on top of `5e660ecf`

- [ ] **Step 2: Install deps and confirm baseline tests pass**

```bash
bun install
bun run typecheck
bun run lint
bun run audit:coverage-floor:build-lcov
bun run audit:coverage-floor
```

Expected: all five exit 0 (the floor gate is green at baseline by definition; the build-lcov step takes several minutes — that's normal).

- [ ] **Step 3: Out-of-band cleanup (optional, Windows only)**

If the stale Phase 4 worktree directory still exists at `../coverage-floor-phase-4-2026-05-21/`:

```bash
# From the worktree root, escape one level then run cleanup
rm -rf ../coverage-floor-phase-4-2026-05-21/ 2>/dev/null || true
```

If `rm -rf` fails with "File name too long" on Windows, drop into PowerShell:

```powershell
Remove-Item -LiteralPath '.worktrees/coverage-floor-phase-4-2026-05-21' -Recurse -Force
```

If both fail, leave it in place (cost is disk space only; the directory is git-ignored).

---

## Task 1 (Commit 1): Drop 6 stale baseline entries already in structural exclusions

**Files:**
- Modify: `docs/structure-audit/coverage-baseline.json`

These 6 entries were marked for removal in Phase 4 commit 1 (Task 1 Step 6) but the final `update-baseline` regenerated them. They are already in `EXCLUSIONS` (verified at lines 60, 71-72, 87-89 of `scripts/coverage-floor/exclusions.ts`), so the floor gate doesn't flag them — but they're stale and inflate the baseline count.

- [ ] **Step 1: Remove the 6 entries from `docs/structure-audit/coverage-baseline.json`**

Delete these 6 entries from the `files` object (each is 3 lines including its `min_coverage_pct: 0` block):

```
packages/gateway/src/connectors/index.ts
packages/gateway/src/db/query-guard-worker.ts
packages/gateway/src/embedding/embedding-runtime.ts
packages/gateway/src/embedding/embedding-worker.ts
packages/gateway/src/index/ranked-item.ts
packages/gateway/src/vault/nimbus-vault.ts
```

Use the Edit tool with each entry as the `old_string`. Example for the first:

```
    "packages/gateway/src/connectors/index.ts": {
      "min_coverage_pct": 0
    },
```

Replace with empty string. Do the same for the other 5.

- [ ] **Step 2: Verify the floor gate**

```bash
bun run audit:coverage-floor
```

Expected: exit 0. The baseline still has the file entries (you've just removed 6), and the floor logic for excluded files takes precedence over baseline ratchet, so this is a no-op for gate behavior.

- [ ] **Step 3: Lint + commit**

```bash
bun run lint:fix
git add docs/structure-audit/coverage-baseline.json
git status
```

Expected: only `coverage-baseline.json` staged.

```bash
git commit -m "$(cat <<'EOF'
chore(coverage-floor): drop 6 stale baseline entries already in structural exclusions

Phase 5 commit 1 of 13. These 6 entries were marked for removal in
Phase 4 commit 1 (Task 1 Step 6) but the final update-baseline
regenerated them. They are already in EXCLUSIONS (lines 60, 71-72,
87-89 of scripts/coverage-floor/exclusions.ts), so the floor gate
doesn't flag them - but they're stale baseline noise.

Entries dropped (all at min_coverage_pct: 0, all already exempted):
- connectors/index.ts (pure re-export)
- db/query-guard-worker.ts (Bun Worker entry)
- embedding/embedding-runtime.ts (type-only)
- embedding/embedding-worker.ts (Bun Worker entry)
- index/ranked-item.ts (type-only)
- vault/nimbus-vault.ts (interface-only)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2 (Commit 2): Structurally exclude `platform/index.ts` + `vault/factory.ts`

**Files:**
- Modify: `scripts/coverage-floor/exclusions.ts`
- Modify: `sonar-project.properties`
- Modify: `docs/structure-audit/coverage-baseline.json`

Both files are async per-OS dispatchers (`await import("./win32.ts")` / `./darwin.ts` / `./linux.ts` with side effects). On any single CI OS, only one switch arm is reachable; the existing test in each (line 1-17 header) admits this. Direct parallel to `platform/sandbox/sandbox-runner.ts` (already excluded at line 52 of `EXCLUSIONS`).

- [ ] **Step 1: Add 2 exact-path entries to `EXCLUSIONS` in `scripts/coverage-floor/exclusions.ts`**

Use the Edit tool. Find the block where `platform/sandbox/sandbox-runner.ts` is excluded (around line 46-52), and add a parallel block immediately after it. Insert exactly this code:

```typescript
  // Async per-OS dispatchers — same shape as platform/sandbox/sandbox-runner.ts
  // above. Each calls `await import("./<os>.ts").<factory>(...)` and only one
  // switch arm is reachable per CI run. Tests cover the freebsd default branch
  // (PlatformInitError throw) for both — verified by each file's test header.
  { kind: "exact", path: "packages/gateway/src/platform/index.ts" },
  { kind: "exact", path: "packages/gateway/src/vault/factory.ts" },
```

Find the literal:

```typescript
  { kind: "exact", path: "packages/gateway/src/platform/sandbox/sandbox-runner.ts" },
```

…and append the new block right after the closing `},` of that line.

- [ ] **Step 2: Mirror the same 2 paths in `sonar-project.properties`**

Find line 54 (`sonar.coverage.exclusions=...`) using:

```bash
grep -n "sonar.coverage.exclusions" sonar-project.properties
```

Append the two paths to the comma-separated list. The new line ends like:

```
…,packages/gateway/src/vault/ffi-ptr.ts,packages/gateway/src/platform/index.ts,packages/gateway/src/vault/factory.ts
```

(Pick any sensible insertion point — alphabetical or end-of-line is fine. No trailing comma. No wildcards.)

- [ ] **Step 3: Run the parity check**

```bash
bun run audit:exclusion-parity
```

Expected: exit 0 (`exclusions.ts` and `sonar-project.properties` agree).

- [ ] **Step 4: Drop the 2 entries from `coverage-baseline.json`**

Delete these two entries (3 lines each):

```
    "packages/gateway/src/platform/index.ts": {
      "min_coverage_pct": 63.64
    },
    "packages/gateway/src/vault/factory.ts": {
      "min_coverage_pct": 75
    },
```

(Note: 63.64 and 75 are the current values; if the build-lcov from Task 0 measured slightly different values, match those instead. Open the baseline file to confirm before editing.)

- [ ] **Step 5: Re-run the floor gate**

```bash
bun run audit:coverage-floor
```

Expected: exit 0. The two files are now exempted via `isExempt(path)`, so they're skipped by the floor walker entirely.

- [ ] **Step 6: Lint + commit**

```bash
bun run lint:fix
git add scripts/coverage-floor/exclusions.ts sonar-project.properties \
        docs/structure-audit/coverage-baseline.json
git commit -m "$(cat <<'EOF'
chore(coverage-floor): structurally exclude per-OS async dispatchers

Phase 5 commit 2 of 13. Adds exclusions for:
- packages/gateway/src/platform/index.ts (async createPlatformServices)
- packages/gateway/src/vault/factory.ts (async createNimbusVault)

Both are async dispatchers that call `await import("./<os>.ts").<factory>(...)`
with per-OS side effects (FFI / subprocess load). Only one switch arm is
reachable on any single CI OS; the existing test in each covers the
freebsd default branch (PlatformInitError) but cannot reach the three OS
arms cross-platform. Direct parallel to platform/sandbox/sandbox-runner.ts
which has the identical pattern and identical exclusion rationale.

The existing tests stay in place - they assert the PlatformInitError
re-export contract and the default-branch behavior, which is the only
runtime coverage we can honestly claim cross-OS.

Drops both entries from coverage-baseline.json (was 63.64% / 75%).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3 (Commit 3): Finish 5 Phase 4 partials (Tier A nudges)

**Files (each is an extend or create-if-absent):**

| Source file | Current | Target | Test file |
|---|---|---|---|
| `packages/gateway/src/agents/impact.ts` | 77.81% | ≥80% | `agents/impact.test.ts` |
| `packages/gateway/src/db/verify.ts` | 78.44% | ≥80% | `db/verify.test.ts` |
| `packages/gateway/src/embedding/create-embedding-runtime.ts` | 77.38% | ≥80% | `embedding/create-embedding-runtime.test.ts` |
| `packages/gateway/src/platform/assemble.ts` | 77.75% | ≥80% | `platform/assemble.test.ts` |
| `packages/gateway/src/connectors/filesystem-v2-sync.ts` | 73.82% | ≥80% | `connectors/filesystem-v2-sync.test.ts` |

For each file, the workflow is identical:

- [ ] **Step A: Build lcov and inspect the uncovered lines**

```bash
bun run audit:coverage-floor:build-lcov
# After build, look at coverage/lcov.info for the SF: block of the file.
# DA:<line>,0 entries are uncovered lines.
```

For each source file in scope, search the lcov for `SF:packages/gateway/src/<path>` and read the `DA:` records. Cross-reference with the source file to identify which branch is uncovered.

- [ ] **Step B: Find or extend the colocated test file**

```bash
ls packages/gateway/src/<dir>/<name>.test.ts 2>/dev/null || echo "create new"
```

If the file exists, append cases under the existing `describe(...)`. If not, create with the standard skeleton.

- [ ] **Step C: Write 1–3 new cases targeting the uncovered branches**

Per file (case names are guesses — adapt after reading the actual uncovered lines):

- `agents/impact.ts` — 2 cases: empty-corpus path (no `git_repo`s returned) + LLM-disabled deterministic synthesis fallback via `_lib/synthesize.ts` path.
- `db/verify.ts` — 1–2 cases targeting whatever branch remains uncovered (FTS5-orphan check or schema-version-too-new).
- `embedding/create-embedding-runtime.ts` — 1–2 cases: vault-key-set-but-empty vs missing distinction for the OpenAI provider branch.
- `platform/assemble.ts` — 1–2 cases: a remaining `XDG_*` permutation Phase 4 didn't reach (e.g. `XDG_RUNTIME_DIR` unset on Linux fallthrough).
- `connectors/filesystem-v2-sync.ts` — 2–3 cases via `connector-sync-harness.ts`: symlink-cycle detector + dot-file-skip branch + watermark-resume.

For the `connector-sync-harness.ts` consumer, the pattern (see existing `filesystem-v2-sync.test.ts`) is:

```typescript
import { makeFilesystemSyncFixture } from "../../test/helpers/connector-sync-harness.ts";
// (path may differ; locate the harness with `bun run --silent <something>` or grep)
```

- [ ] **Step D: Run the per-file test**

```bash
bun test packages/gateway/src/<dir>/<name>.test.ts
```

Expected: all green, including pre-existing cases.

- [ ] **Step E: Repeat for the remaining 4 files**

- [ ] **Step F: Run gateway suite + floor gate**

```bash
bun test packages/gateway
bun run audit:coverage-floor:build-lcov
bun run audit:coverage-floor
```

Expected: tests green. Floor gate may still flag "must-remove" for the 5 raised files — that's fine; baseline drops in commit 13.

- [ ] **Step G: Lint + commit**

```bash
bun run lint:fix
git add packages/gateway/src/
git commit -m "$(cat <<'EOF'
test(near-floor): finish 5 Phase 4 partials (Tier A)

Phase 5 commit 3 of 13. ~8-10 new cases across 5 files raised from
73-78% to >=80%:

- agents/impact.ts (77.81% -> >=80%)
- db/verify.ts (78.44% -> >=80%)
- embedding/create-embedding-runtime.ts (77.38% -> >=80%)
- platform/assemble.ts (77.75% -> >=80%)
- connectors/filesystem-v2-sync.ts (73.82% -> >=80%, via
  connector-sync-harness.ts)

Closes the Phase 4 long-tail bucket.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4 (Commit 4): New tests for `platform/paths.ts`

**Files:**
- Create: `packages/gateway/src/platform/paths.test.ts`

The three exported functions (`createWindowsPaths`, `createDarwinPaths`, `createLinuxPaths`) are pure and parameterized by env vars + `homedir()` + `tmpdir()`. The 39.62% baseline reflects absence of a test, not untestability.

- [ ] **Step 1: Read the source file**

```bash
cat packages/gateway/src/platform/paths.ts
```

Confirm `processEnvGet` is imported from `./env-access.ts`. The functions use `processEnvGet("APPDATA")` etc., not direct `process.env` access — so the env stub goes through `mock.module("./env-access.ts", ...)`.

- [ ] **Step 2: Create `platform/paths.test.ts` with TTY-independent env stubs**

```typescript
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Stubbable env access. Each test sets `envStub[key]` to control what
// `processEnvGet(key)` returns inside paths.ts.
let envStub: Record<string, string | undefined> = {};
import { mock } from "bun:test";
mock.module("./env-access.ts", () => ({
  processEnvGet: (k: string): string | undefined => envStub[k],
}));

// Import AFTER the mock is installed.
const { createWindowsPaths, createDarwinPaths, createLinuxPaths } = await import("./paths.ts");
const { PlatformInitError } = await import("./errors.ts");

describe("createWindowsPaths", () => {
  beforeEach(() => {
    envStub = {};
  });
  afterEach(() => {
    envStub = {};
  });

  it("derives configDir from APPDATA and dataDir from LOCALAPPDATA", () => {
    envStub["APPDATA"] = "C:\\Users\\Test\\AppData\\Roaming";
    envStub["LOCALAPPDATA"] = "C:\\Users\\Test\\AppData\\Local";
    const paths = createWindowsPaths();
    expect(paths.configDir).toBe("C:\\Users\\Test\\AppData\\Roaming\\Nimbus");
    expect(paths.dataDir).toBe("C:\\Users\\Test\\AppData\\Local\\Nimbus\\data");
    expect(paths.logDir.endsWith("logs")).toBe(true);
    expect(paths.socketPath).toBe("\\\\.\\pipe\\nimbus-gateway");
    expect(paths.extensionsDir).toBe("C:\\Users\\Test\\AppData\\Local\\Nimbus\\extensions");
  });

  it("throws PlatformInitError when APPDATA is missing", () => {
    envStub["LOCALAPPDATA"] = "C:\\Users\\Test\\AppData\\Local";
    expect(() => createWindowsPaths()).toThrow(PlatformInitError);
  });

  it("throws PlatformInitError when LOCALAPPDATA is missing", () => {
    envStub["APPDATA"] = "C:\\Users\\Test\\AppData\\Roaming";
    expect(() => createWindowsPaths()).toThrow(PlatformInitError);
  });

  it("throws PlatformInitError when APPDATA is empty string", () => {
    envStub["APPDATA"] = "";
    envStub["LOCALAPPDATA"] = "C:\\Users\\Test\\AppData\\Local";
    expect(() => createWindowsPaths()).toThrow(PlatformInitError);
  });
});

describe("createDarwinPaths", () => {
  beforeEach(() => {
    envStub = {};
  });
  afterEach(() => {
    envStub = {};
  });

  it("places configDir + dataDir under Library/Application Support/Nimbus", () => {
    const paths = createDarwinPaths();
    const expectedRoot = join(homedir(), "Library", "Application Support", "Nimbus");
    expect(paths.configDir).toBe(expectedRoot);
    expect(paths.dataDir).toBe(expectedRoot);
    expect(paths.logDir).toBe(join(expectedRoot, "logs"));
  });

  it("uses TMPDIR for the socketPath base when set", () => {
    envStub["TMPDIR"] = "/private/var/tmp/custom";
    const paths = createDarwinPaths();
    expect(paths.socketPath).toBe("/private/var/tmp/custom/nimbus-gateway.sock");
  });

  it("falls back to /tmp for the socketPath base when TMPDIR is unset", () => {
    const paths = createDarwinPaths();
    expect(paths.socketPath).toBe("/tmp/nimbus-gateway.sock");
  });
});

describe("createLinuxPaths", () => {
  beforeEach(() => {
    envStub = {};
  });
  afterEach(() => {
    envStub = {};
  });

  it("uses XDG_CONFIG_HOME + XDG_DATA_HOME + XDG_RUNTIME_DIR when set", () => {
    envStub["XDG_CONFIG_HOME"] = "/var/test/config";
    envStub["XDG_DATA_HOME"] = "/var/test/data";
    envStub["XDG_RUNTIME_DIR"] = "/run/user/1000";
    const paths = createLinuxPaths();
    expect(paths.configDir).toBe("/var/test/config/nimbus");
    expect(paths.dataDir).toBe("/var/test/data/nimbus");
    expect(paths.socketPath).toBe("/run/user/1000/nimbus-gateway.sock");
  });

  it("falls back to ~/.config and ~/.local/share when XDG vars are unset", () => {
    const paths = createLinuxPaths();
    const home = homedir();
    expect(paths.configDir).toBe(join(home, ".config", "nimbus"));
    expect(paths.dataDir).toBe(join(home, ".local", "share", "nimbus"));
  });

  it("falls back to tmpdir() for the socket runtime dir when XDG_RUNTIME_DIR is unset", () => {
    const paths = createLinuxPaths();
    expect(paths.socketPath).toBe(join(tmpdir(), "nimbus-gateway.sock"));
  });
});
```

- [ ] **Step 3: Run the test**

```bash
bun test packages/gateway/src/platform/paths.test.ts
```

Expected: all 10 cases pass.

- [ ] **Step 4: Confirm coverage rose**

```bash
bun run audit:coverage-floor:build-lcov
grep -A 3 "platform/paths.ts" coverage/lcov.info | head -10
```

Expected: file's `LF:`/`LH:` shows coverage ≥80%.

- [ ] **Step 5: Lint + commit**

```bash
bun run lint:fix
git add packages/gateway/src/platform/paths.test.ts
git commit -m "$(cat <<'EOF'
test(platform): cover paths.ts cross-platform via env stubbing

Phase 5 commit 4 of 13. ~10 new cases covering createWindowsPaths,
createDarwinPaths, createLinuxPaths via mock.module of env-access.ts.
The three functions are pure - the 39.62% baseline reflected absence
of any test, not untestability.

39.62% -> >=80%.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5 (Commit 5): Nudge `tui/detect-fallback.ts` above 80%

**Files:**
- Modify: `packages/cli/src/tui/detect-fallback.test.ts`

44-line pure helper. The 69.23% baseline means `currentFallbackEnv()` (reads process globals) and a few first-match branches of `detectFallbackReason` aren't covered.

- [ ] **Step 1: Read the source and existing test**

```bash
cat packages/cli/src/tui/detect-fallback.ts
cat packages/cli/src/tui/detect-fallback.test.ts
```

- [ ] **Step 2: Extend the test file with 2 missing-branch cases**

Append these cases under the existing describe block in `detect-fallback.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
// (existing imports already present)
import { currentFallbackEnv } from "./detect-fallback.ts";

describe("currentFallbackEnv (process globals)", () => {
  const ORIG_TERM = process.env["TERM"];
  const ORIG_NO_COLOR = process.env["NO_COLOR"];
  const ORIG_CI = process.env["CI"];
  let origIsTty: PropertyDescriptor | undefined;
  let origColumns: PropertyDescriptor | undefined;
  let origRows: PropertyDescriptor | undefined;

  beforeEach(() => {
    origIsTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    origColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    origRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
  });

  afterEach(() => {
    if (ORIG_TERM === undefined) delete process.env["TERM"];
    else process.env["TERM"] = ORIG_TERM;
    if (ORIG_NO_COLOR === undefined) delete process.env["NO_COLOR"];
    else process.env["NO_COLOR"] = ORIG_NO_COLOR;
    if (ORIG_CI === undefined) delete process.env["CI"];
    else process.env["CI"] = ORIG_CI;
    if (origIsTty) Object.defineProperty(process.stdout, "isTTY", origIsTty);
    if (origColumns) Object.defineProperty(process.stdout, "columns", origColumns);
    if (origRows) Object.defineProperty(process.stdout, "rows", origRows);
  });

  it("reflects current process globals", () => {
    process.env["TERM"] = "xterm-256color";
    delete process.env["NO_COLOR"];
    delete process.env["CI"];
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "columns", { value: 120, configurable: true });
    Object.defineProperty(process.stdout, "rows", { value: 40, configurable: true });
    const env = currentFallbackEnv();
    expect(env.TERM).toBe("xterm-256color");
    expect(env.NO_COLOR).toBeUndefined();
    expect(env.CI).toBeUndefined();
    expect(env.isTTY).toBe(true);
    expect(env.columns).toBe(120);
    expect(env.rows).toBe(40);
  });

  it("returns isTTY=false when stdout has no TTY", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: undefined, configurable: true });
    const env = currentFallbackEnv();
    expect(env.isTTY).toBe(false);
  });
});

// If the existing test doesn't cover the "CI=true" or "rows-too-small" branches,
// add these to the existing detectFallbackReason describe:

describe("detectFallbackReason — uncovered branches", () => {
  it("returns CI=true when env.CI is exactly 'true' and prior checks pass", () => {
    const result = detectFallbackReason({
      TERM: "xterm",
      NO_COLOR: undefined,
      CI: "true",
      isTTY: true,
      columns: 120,
      rows: 40,
    });
    expect(result).toBe("CI=true");
  });

  it("returns rows-too-small when rows < MIN_HEIGHT_THRESHOLD", () => {
    const result = detectFallbackReason({
      TERM: "xterm",
      NO_COLOR: undefined,
      CI: undefined,
      isTTY: true,
      columns: 120,
      rows: 5,
    });
    expect(result).toBe("rows-too-small");
  });
});
```

(If the existing test already covers one of these branches, omit it. The goal is to fill specifically the gap that brings the file from 69.23% to ≥80%.)

- [ ] **Step 3: Run the test**

```bash
bun test packages/cli/src/tui/detect-fallback.test.ts
```

Expected: green.

- [ ] **Step 4: Confirm coverage rose**

```bash
bun run audit:coverage-floor:build-lcov
grep -A 3 "tui/detect-fallback.ts" coverage/lcov.info | head -10
```

Expected: ≥80%.

- [ ] **Step 5: Lint + commit**

```bash
bun run lint:fix
git add packages/cli/src/tui/detect-fallback.test.ts
git commit -m "$(cat <<'EOF'
test(tui): nudge detect-fallback.ts above 80%

Phase 5 commit 5 of 13. ~3-4 new cases covering:
- currentFallbackEnv() reads process globals
- currentFallbackEnv() handles missing isTTY descriptor
- detectFallbackReason CI=true branch
- detectFallbackReason rows-too-small branch

69.23% -> >=80%.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6 (Commit 6): New tests for `extensions/registry-fetcher.ts`

**Files:**
- Create: `packages/gateway/src/extensions/registry-fetcher.test.ts`

The 50-line file at 0% baseline. Reads installed manifest from disk when the dep id is already installed; otherwise hits the registry HTTP endpoint.

- [ ] **Step 1: Read the source**

```bash
cat packages/gateway/src/extensions/registry-fetcher.ts
```

Identify the exported `createRegistryFetcher` function and its return interface. Note any dependencies (`fetch`, `fs`, vault, paths).

- [ ] **Step 2: Create the test**

Skeleton (adapt to match the actual function signature read in Step 1):

```typescript
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistryFetcher } from "./registry-fetcher.ts";

describe("createRegistryFetcher", () => {
  let tmpDir: string;
  let extensionsDir: string;
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nimbus-reg-fetcher-"));
    extensionsDir = join(tmpDir, "extensions");
    mkdirSync(extensionsDir, { recursive: true });
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves an installed dep from on-disk manifest without network", async () => {
    const depId = "com.example.foo";
    const installedManifestDir = join(extensionsDir, depId);
    mkdirSync(installedManifestDir, { recursive: true });
    writeFileSync(
      join(installedManifestDir, "nimbus.extension.json"),
      JSON.stringify({ id: depId, version: "1.0.0", permissions: {} }),
    );

    // Stub fetch to ensure it isn't called.
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const fetcher = createRegistryFetcher({ extensionsDir, registryBaseUrl: "https://registry.example" });
    const result = await fetcher.fetchManifest(depId, "1.0.0");
    expect(result).not.toBeNull();
    expect(result?.id).toBe(depId);
    expect(fetchCalled).toBe(false);
  });

  it("hits the registry HTTP endpoint when the dep is not installed", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetchCalled = true;
      expect(String(input)).toContain("registry.example");
      return new Response(
        JSON.stringify({ id: "com.example.bar", version: "2.0.0", permissions: {} }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const fetcher = createRegistryFetcher({ extensionsDir, registryBaseUrl: "https://registry.example" });
    const result = await fetcher.fetchManifest("com.example.bar", "2.0.0");
    expect(fetchCalled).toBe(true);
    expect(result?.id).toBe("com.example.bar");
  });

  it("returns null when registry returns 404", async () => {
    globalThis.fetch = (async () => new Response("", { status: 404 })) as typeof fetch;

    const fetcher = createRegistryFetcher({ extensionsDir, registryBaseUrl: "https://registry.example" });
    const result = await fetcher.fetchManifest("com.example.missing", "1.0.0");
    expect(result).toBeNull();
  });

  it("propagates a typed offline error when fetch throws", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const fetcher = createRegistryFetcher({ extensionsDir, registryBaseUrl: "https://registry.example" });
    await expect(fetcher.fetchManifest("com.example.offline", "1.0.0")).rejects.toThrow();
  });
});
```

**Important:** The actual function signature, parameter names, and return shape are **not yet verified**. The implementer must adapt the test skeleton to the real interface read in Step 1. The 4 cases (installed-local, registry-hit, 404, offline-throw) cover the file's main branches at the conceptual level.

- [ ] **Step 3: Run the test**

```bash
bun test packages/gateway/src/extensions/registry-fetcher.test.ts
```

Expected: 4 cases pass.

- [ ] **Step 4: Confirm coverage**

```bash
bun run audit:coverage-floor:build-lcov
grep -A 3 "extensions/registry-fetcher.ts" coverage/lcov.info | head -10
```

Expected: ≥80%.

- [ ] **Step 5: Lint + commit**

```bash
bun run lint:fix
git add packages/gateway/src/extensions/registry-fetcher.test.ts
git commit -m "$(cat <<'EOF'
test(extensions): cover registry-fetcher.ts (Tier C)

Phase 5 commit 6 of 13. ~4 new cases:
- installed-dep resolves from on-disk manifest, no fetch
- uninstalled dep hits registry HTTP endpoint
- 404 returns null
- offline fetch throws -> propagated to caller

0% -> >=80%.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7 (Commit 7): New tests for `ipc/http-server.ts` lifecycle

**Files:**
- Create: `packages/gateway/src/ipc/http-server.test.ts`

The 65.12% baseline already comes from route-targeted tests under `packages/gateway/test/integration/http/` (`openapi-route.test.ts`, `metrics-dora-route.test.ts`, `deployments-post-route.test.ts`). The uncovered 35% is **lifecycle scaffolding** — not route logic. Target lifecycle, not duplicate routes.

- [ ] **Step 1: Read the source + the integration-test precedent**

```bash
cat packages/gateway/src/ipc/http-server.ts
cat packages/gateway/test/integration/http/openapi-route.test.ts
```

Note the `startReadOnlyHttpServer(dbPath, port, opts?)` signature and the `ReadOnlyHttpServerHandle` interface (`.port`, `.stop()`).

Uncovered branches likely include:
- The 405-on-known-write-path branch (lines 373-378).
- The POST → write-surface dispatch path when `resolveDeploymentToken` is undefined (returns 405).
- The POST → write-surface dispatch path when `resolveDeploymentToken` is set (writeDb instantiated, `dispatchWriteRoute` called).
- The `stop()` cleanup branches when each `try/catch` arm fires.

- [ ] **Step 2: Create `http-server.test.ts` focused on lifecycle**

```typescript
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startReadOnlyHttpServer } from "./http-server.ts";

describe("startReadOnlyHttpServer — lifecycle", () => {
  let tmpDir: string;
  let dbPath: string;
  let handle: ReturnType<typeof startReadOnlyHttpServer> | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nimbus-http-server-test-"));
    dbPath = join(tmpDir, "nimbus.db");
    new Database(dbPath).close(); // create empty DB
  });

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("binds to an OS-assigned free port when port=0", () => {
    handle = startReadOnlyHttpServer(dbPath, 0);
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.port).toBeLessThan(65_536);
  });

  it("returns 405 with Allow: GET on POST when no write surface mounted", async () => {
    handle = startReadOnlyHttpServer(dbPath, 0);
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/deployments`, {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
  });

  it("returns 405 with Allow: GET, POST on PUT when write surface IS mounted", async () => {
    handle = startReadOnlyHttpServer(dbPath, 0, {
      resolveDeploymentToken: async () => "test-token",
    });
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/some-path`, { method: "PUT" });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, POST");
  });

  it("returns 405 Allow: POST on GET targeting a write-only route", async () => {
    handle = startReadOnlyHttpServer(dbPath, 0, {
      resolveDeploymentToken: async () => "test-token",
    });
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/deployments`);
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });

  it("returns 404 for unknown GET routes", async () => {
    handle = startReadOnlyHttpServer(dbPath, 0);
    const res = await fetch(`http://127.0.0.1:${handle.port}/no-such-path`);
    expect(res.status).toBe(404);
  });

  it("dispatches POST through dispatchWriteRoute when write surface is mounted and token resolves", async () => {
    handle = startReadOnlyHttpServer(dbPath, 0, {
      resolveDeploymentToken: async () => "test-token",
    });
    // Send a deliberately bad payload — we don't care if it succeeds, only that
    // the dispatcher is reached (no 405). Without bearer auth → 401.
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/deployments`, {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).not.toBe(405);
    // The exact status (401 unauthorized, 400 invalid_json, etc.) depends on
    // dispatchWriteRoute behavior - that's covered by deployments-post-route.test.ts.
    // Here we just assert the POST reached the dispatcher, not the 405 short-circuit.
  });

  it("returns 500 internal_error when resolveDeploymentToken throws", async () => {
    handle = startReadOnlyHttpServer(dbPath, 0, {
      resolveDeploymentToken: async () => {
        throw new Error("vault unavailable");
      },
    });
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/deployments`, {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(500);
  });

  it("stop() can be called multiple times without throwing", () => {
    handle = startReadOnlyHttpServer(dbPath, 0);
    handle.stop();
    expect(() => handle?.stop()).not.toThrow();
    // Mark handle as already-stopped so afterEach doesn't double-stop.
    handle = undefined;
  });

  it("stop() closes the writeDb when one was opened", () => {
    handle = startReadOnlyHttpServer(dbPath, 0, {
      resolveDeploymentToken: async () => "test-token",
    });
    // Just confirm no throw - the writeDb close path is exercised even if we
    // can't observe it externally.
    expect(() => handle?.stop()).not.toThrow();
    handle = undefined;
  });
});
```

- [ ] **Step 3: Run the test**

```bash
bun test packages/gateway/src/ipc/http-server.test.ts
```

Expected: green.

- [ ] **Step 4: Confirm coverage rose**

```bash
bun run audit:coverage-floor:build-lcov
grep -A 3 "ipc/http-server.ts" coverage/lcov.info | head -10
```

Expected: ≥80% (combining the new lifecycle cases with existing route tests).

If <80%, identify which uncovered lines remain (read the lcov `DA:<line>,0` records) and add 1-2 targeted cases. If still <80% after the second pass, raise the watermark.

- [ ] **Step 5: Lint + commit**

```bash
bun run lint:fix
git add packages/gateway/src/ipc/http-server.test.ts
git commit -m "$(cat <<'EOF'
test(ipc): cover http-server.ts via spawned port:0 fixture (Tier B)

Phase 5 commit 7 of 13. ~6-8 new lifecycle cases. Existing 65.12%
baseline came from route-targeted integration tests
(openapi-route.test.ts, metrics-dora-route.test.ts,
deployments-post-route.test.ts); the uncovered 35% was lifecycle
scaffolding - the Bun.serve boundary, the 405/404 dispatcher arms,
the write-surface mounting/disabled paths, and the stop() cleanup
arms. This commit targets that specific gap.

Uses port:0 + handle.port pattern from openapi-route.test.ts to avoid
port-collision flakes on shared CI runners.

65.12% -> >=80%.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8 (Commit 8): Extend `ipc/server/server.ts` listener startup coverage

**Files:**
- Modify: `packages/gateway/src/ipc/server/server.test.ts`

The 76.7% baseline + existing 89-line test mean the test already covers `createIpcServer` factory + `handleRpc` round-trips through `attachSession`. The uncovered 23.3% is the actual Linux/Win32 listener-startup arms.

- [ ] **Step 1: Read source + existing test**

```bash
cat packages/gateway/src/ipc/server/server.ts
cat packages/gateway/src/ipc/server/server.test.ts
```

Identify where `createIpcServer` decides which listener helper to call (`platform() === "win32" ? startWin32NetServer(...) : startBunUnixListener(...)`). The uncovered branch is whichever arm doesn't fire on the host OS.

- [ ] **Step 2: Add 2-3 cases to the existing test that exercise the listener-startup arm**

Append under the existing `describe`:

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("createIpcServer — listener startup (Linux unix socket arm)", () => {
  let tmpDir: string;
  let socketPath: string;
  let serverHandle: Awaited<ReturnType<typeof createIpcServer>>["start"] extends never ? never : Awaited<ReturnType<ReturnType<typeof createIpcServer>["start"]>>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nimbus-server-test-"));
    socketPath = join(tmpDir, "nimbus-gateway.sock");
  });

  afterEach(async () => {
    // ... existing stop logic from the file ...
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("binds a unix socket at the configured listenPath on non-win32", async () => {
    // Skip on Windows; that arm is exercised by Windows CI runner runs.
    if (process.platform === "win32") return;

    const server = createIpcServer({
      listenPath: socketPath,
      /* minimal stubs for required options - see existing test */
    } as Parameters<typeof createIpcServer>[0]);
    const handle = await server.start();
    expect(handle).toBeDefined();
    // Assert socket file now exists at the listenPath
    const { existsSync } = await import("node:fs");
    expect(existsSync(socketPath)).toBe(true);
    await server.stop();
  });

  it("removes a stale socket file at the listenPath before bind", async () => {
    if (process.platform === "win32") return;
    const { writeFileSync, existsSync } = await import("node:fs");
    writeFileSync(socketPath, "stale");
    expect(existsSync(socketPath)).toBe(true);

    const server = createIpcServer({
      listenPath: socketPath,
    } as Parameters<typeof createIpcServer>[0]);
    const handle = await server.start();
    expect(handle).toBeDefined();
    // The bind succeeded - the stale file was cleared.
    await server.stop();
  });
});
```

**Important:** The actual `createIpcServer` options schema is large. The implementer should look at the existing test's setup helpers and reuse them. The two cases above are conceptual — they need to be adapted to the file's actual factory shape (see the existing `server.test.ts` for the minimal-stubs pattern already used there).

- [ ] **Step 3: Run the test**

```bash
bun test packages/gateway/src/ipc/server/server.test.ts
```

Expected: green.

- [ ] **Step 4: Confirm coverage**

```bash
bun run audit:coverage-floor:build-lcov
grep -A 3 "ipc/server/server.ts" coverage/lcov.info | head -10
```

Expected: ≥80%.

- [ ] **Step 5: Lint + commit**

```bash
bun run lint:fix
git add packages/gateway/src/ipc/server/server.test.ts
git commit -m "$(cat <<'EOF'
test(ipc): cover server/server.ts listener startup arm (Tier B)

Phase 5 commit 8 of 13. ~2-3 new cases covering the Linux unix-socket
listener startup arm (Bun.listen + stale-socket removal). The existing
test already covered the createIpcServer factory + handleRpc round-trip
via attachSession stubs; the listener-startup path was the uncovered
~23.3%.

76.7% -> >=80%.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9 (Commit 9): New tests for `ipc/server/socket-listeners.ts`

**Files:**
- Create: `packages/gateway/src/ipc/server/socket-listeners.test.ts`

102-line file at 45.21% baseline (no existing test). Five exported functions: two pure helpers + three listener-startup helpers. All five are testable on Linux using a real `net` module and unix socket paths.

- [ ] **Step 1: Read the source**

```bash
cat packages/gateway/src/ipc/server/socket-listeners.ts
```

Note the five exports: `removeStaleUnixSocketIfPresent`, `chmodListenSocketBestEffort`, `attachWin32Socket`, `startWin32NetServer`, `startBunUnixListener`.

- [ ] **Step 2: Create the test file**

```typescript
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  attachWin32Socket,
  chmodListenSocketBestEffort,
  removeStaleUnixSocketIfPresent,
  startBunUnixListener,
  startWin32NetServer,
} from "./socket-listeners.ts";
import type { ClientSession, SessionWrite } from "../session.ts";

// Minimal ClientSession stub for the attach paths.
function makeStubSession(): ClientSession {
  return {
    push: () => {},
    endInput: () => {},
    dispose: () => {},
    writeNotification: () => {},
  } as unknown as ClientSession;
}

describe("removeStaleUnixSocketIfPresent", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nimbus-sock-stale-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("is a no-op when the path does not exist", () => {
    const path = join(tmpDir, "nope.sock");
    expect(() => removeStaleUnixSocketIfPresent(path)).not.toThrow();
    expect(existsSync(path)).toBe(false);
  });

  it("unlinks a stale socket file", () => {
    const path = join(tmpDir, "stale.sock");
    writeFileSync(path, "x");
    removeStaleUnixSocketIfPresent(path);
    expect(existsSync(path)).toBe(false);
  });

  it("swallows unlink errors silently (best-effort)", () => {
    // Pass a path that exists as a directory — unlink will throw; the function
    // must catch and return.
    const dirPath = join(tmpDir, "dir-as-socket");
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(dirPath);
    expect(() => removeStaleUnixSocketIfPresent(dirPath)).not.toThrow();
  });
});

describe("chmodListenSocketBestEffort", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nimbus-sock-chmod-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("chmods to 0o600 when path exists", () => {
    const path = join(tmpDir, "perm.sock");
    writeFileSync(path, "x");
    expect(() => chmodListenSocketBestEffort(path)).not.toThrow();
  });

  it("swallows errors when path does not exist", () => {
    const path = join(tmpDir, "missing.sock");
    expect(() => chmodListenSocketBestEffort(path)).not.toThrow();
  });
});

describe("attachWin32Socket / startWin32NetServer (cross-platform via unix socket on Linux)", () => {
  let tmpDir: string;
  let socketPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nimbus-sock-win32-"));
    socketPath = join(tmpDir, `nimbus-${randomUUID()}.sock`);
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("starts a net.createServer, accepts a connection, and forwards data through the session", async () => {
    let receivedBytes: Uint8Array | null = null;
    let ended = false;
    const stubSession: ClientSession = {
      push: (data: Uint8Array) => {
        receivedBytes = data;
      },
      endInput: () => {
        ended = true;
      },
      dispose: () => {},
      writeNotification: () => {},
    } as unknown as ClientSession;

    const attach = (_write: SessionWrite): ClientSession => stubSession;
    const { netServer, winSockets } = await startWin32NetServer(socketPath, attach);

    // Connect a client, send a byte, close.
    await new Promise<void>((resolve, reject) => {
      const client = net.connect(socketPath, () => {
        client.write(Buffer.from([0x41])); // 'A'
        client.end();
      });
      client.on("close", () => resolve());
      client.on("error", reject);
    });

    // Allow a microtask for the server's on('data') / on('end') to fire.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(receivedBytes).not.toBeNull();
    expect(receivedBytes![0]).toBe(0x41);
    expect(ended).toBe(true);

    netServer.close();
    expect(winSockets.size).toBe(0); // socket should have been removed on close
  });
});

describe("startBunUnixListener", () => {
  let tmpDir: string;
  let socketPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nimbus-sock-bununix-"));
    socketPath = join(tmpDir, `nimbus-${randomUUID()}.sock`);
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("opens a Bun unix listener and routes data through the session", async () => {
    if (process.platform === "win32") return; // Bun.listen({unix: ...}) is POSIX-only
    let received: Uint8Array | null = null;
    let ended = false;
    const stubSession: ClientSession = {
      push: (data: Uint8Array) => {
        received = data;
      },
      endInput: () => {
        ended = true;
      },
      dispose: () => {},
      writeNotification: () => {},
    } as unknown as ClientSession;

    const attach = (_write: SessionWrite): ClientSession => stubSession;
    const listener = startBunUnixListener(socketPath, attach);

    // Connect via Bun.connect (or node:net) and write a byte.
    await new Promise<void>((resolve, reject) => {
      const client = net.connect(socketPath, () => {
        client.write(Buffer.from([0x42])); // 'B'
        client.end();
      });
      client.on("close", () => resolve());
      client.on("error", reject);
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(received).not.toBeNull();
    expect(received![0]).toBe(0x42);
    expect(ended).toBe(true);

    listener.stop();
  });
});
```

- [ ] **Step 3: Run the test**

```bash
bun test packages/gateway/src/ipc/server/socket-listeners.test.ts
```

Expected: green. Some tests may legitimately fail on first pass — usually due to:
- Timing: the 50ms wait may be insufficient on a loaded runner. Bump to 100ms.
- Type stubs: `ClientSession` shape may have evolved; check `../session.ts` for the current interface.
- Bun unix listener type: `Bun.listen<BunSessionData>` returns a Bun-specific handle, not a Node `net.Server`. Use the listener's actual stop API.

If 80% isn't reached on first lcov check after this commit, identify the still-uncovered lines and add 1-2 targeted cases. If the residual is genuinely Win32-only logic that can't be tested cross-platform, **split the file**: extract the cross-platform pure helpers into `socket-listeners.ts` (keep cases), move the Win32-only logic into `win32-listener.ts`, and add the new file to BOTH `EXCLUSIONS` and `sonar-project.properties` in the same commit.

**Parity-bump checklist if file is split:**

(a) Add `packages/gateway/src/ipc/server/win32-listener.ts` to `EXCLUSIONS` in `scripts/coverage-floor/exclusions.ts` with a rationale comment.
(b) Mirror the same path in `sonar-project.properties` under `sonar.coverage.exclusions`.
(c) Run `bun run audit:exclusion-parity` — exit 0 before the commit lands.

- [ ] **Step 4: Confirm coverage**

```bash
bun run audit:coverage-floor:build-lcov
grep -A 3 "ipc/server/socket-listeners.ts" coverage/lcov.info | head -10
```

Expected: ≥80%.

- [ ] **Step 5: Lint + commit**

```bash
bun run lint:fix
git add packages/gateway/src/ipc/server/socket-listeners.test.ts
# If split was needed, also:
# git add scripts/coverage-floor/exclusions.ts sonar-project.properties packages/gateway/src/ipc/server/win32-listener.ts
git commit -m "$(cat <<'EOF'
test(ipc): cover socket-listeners.ts helpers + attach + listen (Tier B)

Phase 5 commit 9 of 13. ~6 new cases covering:
- removeStaleUnixSocketIfPresent (no-op / unlink / swallow-error)
- chmodListenSocketBestEffort (success / missing-path-swallow)
- startWin32NetServer + attachWin32Socket (real net.createServer +
  client.connect with unix socket path; verifies push() and endInput()
  on the session)
- startBunUnixListener (Bun.listen with unix socket path; same data-flow
  verification)

The Win32-named functions use plain `net` module APIs that work
cross-platform; tests pass unix socket paths under tmp dirs (never
named-pipe paths) so Linux CI exercises every arm.

45.21% -> >=80%.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10 (Commit 10): Extend `cli/src/tui/App.tsx` via `ink-testing-library`

**Files:**
- Modify: `packages/cli/src/tui/App.test.tsx`

The 57.6% baseline + 155-line existing test means some state transitions are covered but many render branches aren't. `ink-testing-library` is already a CLI dep (`packages/cli/package.json` declares `"ink-testing-library": "^4.0.0"`).

- [ ] **Step 1: Read the source + existing test**

```bash
cat packages/cli/src/tui/App.tsx
cat packages/cli/src/tui/App.test.tsx
```

Identify which state-machine transitions the existing test exercises and which it skips. State machine lives in `tui/state.ts` (already ≥80% coverage); App.tsx renders different children per state.

- [ ] **Step 2: Add cases that cover uncovered state-render branches with explicit TTY stubs**

Append under the existing describe in `App.test.tsx`:

```typescript
import { afterEach, beforeEach } from "bun:test";

// Headless CI has process.stdout.isTTY=false, which silently exercises
// App.tsx's non-Ink fallback branch. To cover the interactive surface,
// stub TTY props in beforeEach and restore in afterEach.
describe("App — uncovered state-render branches", () => {
  let origIsTty: PropertyDescriptor | undefined;
  let origColumns: PropertyDescriptor | undefined;
  let origRows: PropertyDescriptor | undefined;

  beforeEach(() => {
    origIsTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    origColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    origRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "columns", { value: 120, configurable: true });
    Object.defineProperty(process.stdout, "rows", { value: 40, configurable: true });
  });

  afterEach(() => {
    if (origIsTty) Object.defineProperty(process.stdout, "isTTY", origIsTty);
    else delete (process.stdout as unknown as { isTTY?: boolean }).isTTY;
    if (origColumns) Object.defineProperty(process.stdout, "columns", origColumns);
    if (origRows) Object.defineProperty(process.stdout, "rows", origRows);
  });

  it("renders the disconnected state when gateway connection drops", () => {
    // Use ink-testing-library's render() with a stubbed gateway client that
    // emits a disconnect event. The exact prop shape depends on App.tsx's
    // current API - mirror the existing test's setup.
    // Assert: rendered output contains the disconnected indicator string.
  });

  it("renders the awaiting-hitl pane when state transitions to awaiting-hitl", () => {
    // ...
  });

  it("renders the streaming pane with token feed when state is streaming", () => {
    // ...
  });

  it("renders the idle/input prompt when state returns to idle after streaming-done", () => {
    // ...
  });
});
```

**Important:** The actual prop shape, state-machine API, and render assertions depend on `App.tsx`'s current code. The 4 cases above name state-transition coverage gaps conceptually; the implementer must adapt them to the real surface by reading both `App.tsx` and `state.ts`.

If 80% isn't reached after this commit, **raise the watermark** — `App.tsx` is 363 lines of React Ink and may have render branches that need rather involved children-stubbing to reach. The Phase 4 precedent for "partial coverage + raised watermark" applies here.

- [ ] **Step 3: Run the test**

```bash
bun test packages/cli/src/tui/App.test.tsx
```

Expected: green.

- [ ] **Step 4: Confirm coverage**

```bash
bun run audit:coverage-floor:build-lcov
grep -A 3 "tui/App.tsx" coverage/lcov.info | head -10
```

Expected: ≥80% if reachable; otherwise note the new measured value and prepare to raise the watermark in commit 13.

- [ ] **Step 5: Lint + commit**

```bash
bun run lint:fix
git add packages/cli/src/tui/App.test.tsx
git commit -m "$(cat <<'EOF'
test(tui): extend App.tsx coverage via ink-testing-library (Tier B)

Phase 5 commit 10 of 13. ~4 new cases driving state-machine
transitions: disconnected, awaiting-hitl, streaming, idle-after-done.
Uses explicit process.stdout.isTTY / .columns / .rows stubs in
beforeEach + restore in afterEach so the interactive render branch
is exercised on headless CI (which defaults to isTTY=false).

ink-testing-library was already a declared CLI dep at ^4.0.0 - no
bun add needed.

57.6% -> >=80% (raise watermark if not reached; document residual in
PR body).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11 (Commit 11): Raise `extensions/install-from-local.ts` above 80%

**Files:**
- Modify: `packages/gateway/src/extensions/install-from-local.test.ts` (likely exists, given 66.9% baseline)

808-line file. The Phase 4-commit-7 precedent (`mesh.ts`) was 8 cases for ~500 lines. Budget ~7-10 cases. The plan-author may split this into Tier C-1 (error/early-rejection branches) + Tier C-2 (signature-verification branches) if the source-read identifies two clearly disjoint mock surfaces — same rationale as Phase 4's mesh.ts split.

- [ ] **Step 1: Read the source carefully**

```bash
wc -l packages/gateway/src/extensions/install-from-local.ts
cat packages/gateway/src/extensions/install-from-local.ts | head -100
# scroll through, identifying:
# - exported function entry points
# - audit-log call sites
# - signature-verification branches (I16 wiring)
# - completeExtensionInstallAfterCopy and its failure modes
```

- [ ] **Step 2: Identify uncovered branches**

```bash
bun run audit:coverage-floor:build-lcov
# Look at coverage/lcov.info for the install-from-local.ts SF: block
# DA:<line>,0 entries are uncovered. Print them:
awk '/^SF:packages\/gateway\/src\/extensions\/install-from-local.ts/,/^end_of_record/' coverage/lcov.info | grep "DA:.*,0$"
```

Map each uncovered line to its surrounding branch (open the source at those lines).

- [ ] **Step 3: Decide: single commit or Tier C-1 + Tier C-2 split**

If the uncovered branches cluster into two clearly disjoint groups (e.g. "error-handling pre-copy" + "post-copy signature verification"), **split into two commits**. Each commit lands ~4-5 cases focused on its group. Use commit messages "Phase 5 commit 11a of 13 (error-handling)" + "Phase 5 commit 11b of 13 (signature verification)" — adjust the total commit count in subsequent commits if you split.

If the branches are entangled or fewer than expected, **single commit** is fine.

- [ ] **Step 4: Find or extend the existing test file**

```bash
ls packages/gateway/src/extensions/install-from-local.test.ts 2>&1
```

Assume it exists (66.9% baseline implies some test). Extend with new cases.

Sample cases (adapt after Step 2 mapping):

```typescript
// Error-handling cluster (Tier C-1 if split):
it("rejects install when manifest fails schema validation", async () => { /* ... */ });
it("rejects install when permissions block is missing", async () => { /* ... */ });
it("writes audit entry on each rejection (action.type = extension.install_rejected)", async () => { /* ... */ });
it("rolls back partial copy on failure mid-install", async () => { /* ... */ });

// Signature-verification cluster (Tier C-2 if split):
it("rejects install when manifest signature is malformed (I16)", async () => { /* ... */ });
it("rejects install when signature key does not match vault-stored publisher key (I16)", async () => { /* ... */ });
it("accepts unsigned install when no publisher field is present (pre-T2 PR 2 path)", async () => { /* ... */ });
it("calls assertHitlRequired for every write-permission tool", async () => { /* ... */ });
```

Use `MockVault` from `@nimbus-dev/sdk/testing` + tmp-dir fs for the extension root.

- [ ] **Step 5: Run the test**

```bash
bun test packages/gateway/src/extensions/install-from-local.test.ts
```

Expected: green.

- [ ] **Step 6: Confirm coverage**

```bash
bun run audit:coverage-floor:build-lcov
grep -A 3 "extensions/install-from-local.ts" coverage/lcov.info | head -10
```

Expected: ≥80%. If not, add 1-2 more cases targeting the largest remaining `DA:<line>,0` cluster, or accept raised watermark.

- [ ] **Step 7: Lint + commit (single-commit path)**

```bash
bun run lint:fix
git add packages/gateway/src/extensions/install-from-local.test.ts
git commit -m "$(cat <<'EOF'
test(extensions): raise install-from-local.ts above 80% (Tier C)

Phase 5 commit 11 of 13. ~7-9 new cases covering error-handling
rejections (schema fail, missing permissions, partial-copy rollback),
audit-on-reject writes, and I16 signature-verification branches
(malformed sig, key mismatch, unsigned-pre-T2 path).

66.9% -> >=80%.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

(If split into two commits, write two separate commit messages with the cluster name in each subject. Adjust the "Phase 5 commit N of 13" count downstream.)

---

## Task 12 (Commit 12): Cover `embedding/model.ts` via load-transformer-pipeline shim refactor (Tier D)

**Files:**
- Create: `packages/gateway/src/embedding/load-transformer-pipeline.ts` (new source file)
- Modify: `packages/gateway/src/embedding/model.ts` (replace direct dynamic import with sibling call)
- Modify: `scripts/coverage-floor/exclusions.ts` (add `load-transformer-pipeline.ts` exclusion)
- Modify: `sonar-project.properties` (mirror)
- Create: `packages/gateway/src/embedding/model.test.ts`

**Why a refactor, not a colocation move:** `scripts/coverage-floor/build-lcov.sh:32` runs `bun test --coverage` per package — colocated `*.test.ts` AND `test/integration/**/*.test.ts` share that one bun-test process. `mock.module("@xenova/transformers", ...)` in `create-routing-runtime.test.ts` would collide with the same mock in a new `model.test.ts` regardless of test-file directory. The fix is at the **target** layer: rename the mock target so the two tests mock distinct module paths. **Do NOT relocate `model.test.ts` to `test/integration/` — that doesn't isolate the mock under coverage builds.**

- [ ] **Step 1: Create `embedding/load-transformer-pipeline.ts`**

Write the new file at `packages/gateway/src/embedding/load-transformer-pipeline.ts`:

```typescript
// Thin shim around the lazy `@xenova/transformers` dynamic import.
//
// Exists so that `embedding/model.ts` can be unit-tested without colliding
// with `embedding/create-routing-runtime.test.ts`'s mock of the same package.
// `mock.module(...)` is process-global under `bun test --coverage` (one
// process per package via build-lcov.sh); two test files mocking the same
// target collide. Routing the import through this sibling lets `model.test.ts`
// mock `./load-transformer-pipeline.ts` (a unique target path) while
// `create-routing-runtime.test.ts` continues to mock `@xenova/transformers`
// directly without overlap.
//
// This file has no executable logic of its own — it's a 1-call indirection.
// Structurally excluded from the coverage floor (parallel to vault/ffi-ptr.ts).

import type { env as xenovaEnv, pipeline as xenovaPipeline } from "@xenova/transformers";

export type TransformerEnv = typeof xenovaEnv;
export type TransformerPipeline = typeof xenovaPipeline;

export async function loadTransformerPipeline(): Promise<{
  env: TransformerEnv;
  pipeline: TransformerPipeline;
}> {
  const { env, pipeline } = await import("@xenova/transformers");
  return { env, pipeline };
}
```

If the typed import surface proves awkward to express (e.g. `@xenova/transformers` doesn't export typed `env` / `pipeline`), drop typing to `unknown` at the shim boundary:

```typescript
export async function loadTransformerPipeline(): Promise<{ env: unknown; pipeline: (...args: unknown[]) => Promise<unknown> }> {
  const mod = await import("@xenova/transformers");
  return { env: mod.env, pipeline: mod.pipeline as (...args: unknown[]) => Promise<unknown> };
}
```

- [ ] **Step 2: Modify `embedding/model.ts` to call the shim**

Replace lines 46-49 (the `await import("@xenova/transformers")` call):

Find:
```typescript
export async function createLocalEmbedder(options: CreateLocalEmbedderOptions): Promise<Embedder> {
  const { env, pipeline } = await import("@xenova/transformers");
  const override = processEnvGet("NIMBUS_EMBEDDING_MODEL_DIR");
  env.cacheDir = override !== undefined && override !== "" ? override : options.cacheDir;
```

Replace with:
```typescript
import { loadTransformerPipeline } from "./load-transformer-pipeline.ts";
// ... (keep other imports above) ...

export async function createLocalEmbedder(options: CreateLocalEmbedderOptions): Promise<Embedder> {
  const { env, pipeline } = await loadTransformerPipeline();
  const override = processEnvGet("NIMBUS_EMBEDDING_MODEL_DIR");
  env.cacheDir = override !== undefined && override !== "" ? override : options.cacheDir;
```

Make sure the `import { loadTransformerPipeline } from "./load-transformer-pipeline.ts";` line is added at the top with the other imports.

- [ ] **Step 3: Add `load-transformer-pipeline.ts` to `EXCLUSIONS`**

Find the existing `embedding/embedding-runtime.ts` exclusion entry in `scripts/coverage-floor/exclusions.ts` (around line 87). Add the new entry immediately after the existing block:

```typescript
  // Thin shim around `@xenova/transformers` dynamic import. Exists to
  // give `embedding/model.test.ts` a unique mock.module target (the
  // sibling path) so it does not collide with create-routing-runtime.test.ts's
  // mock of the same upstream package. The shim itself has no executable
  // logic to cover - it's a 1-call indirection. Same exemption rationale
  // as vault/ffi-ptr.ts (thin OS-specific helper imported by exactly one
  // caller).
  { kind: "exact", path: "packages/gateway/src/embedding/load-transformer-pipeline.ts" },
```

- [ ] **Step 4: Mirror in `sonar-project.properties`**

Append `packages/gateway/src/embedding/load-transformer-pipeline.ts` to the comma-separated list on the `sonar.coverage.exclusions=` line (line 54).

- [ ] **Step 5: Verify exclusion parity**

```bash
bun run audit:exclusion-parity
```

Expected: exit 0.

- [ ] **Step 6: Create `embedding/model.test.ts`**

```typescript
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// Mock the SIBLING path (not `@xenova/transformers`) so we don't collide
// with create-routing-runtime.test.ts which mocks the upstream module.
const mockPipelineFn = mock(async () => ({
  data: new Float32Array(384).fill(0.5),
  dims: [1, 384] as const,
}));
const mockPipeline = mock(async () => mockPipelineFn);
const mockEnv = { cacheDir: "" };

mock.module("./load-transformer-pipeline.ts", () => ({
  loadTransformerPipeline: async () => ({
    env: mockEnv,
    pipeline: mockPipeline,
  }),
}));

// Import AFTER the mock is installed.
const { createLocalEmbedder, LOCAL_EMBEDDING_MODEL_ID, MINIMUM_MODEL_VERSION } = await import("./model.ts");

describe("model.ts module exports", () => {
  it("exposes the local model id constant", () => {
    expect(LOCAL_EMBEDDING_MODEL_ID).toBe("all-MiniLM-L6-v2");
  });

  it("exposes the minimum model version", () => {
    expect(MINIMUM_MODEL_VERSION).toBe("1.0.0");
  });
});

describe("createLocalEmbedder", () => {
  const ORIG_ENV = process.env["NIMBUS_EMBEDDING_MODEL_DIR"];

  beforeEach(() => {
    mockPipelineFn.mockReset();
    mockPipelineFn.mockImplementation(async () => ({
      data: new Float32Array(384).fill(0.5),
      dims: [1, 384] as const,
    }));
    mockEnv.cacheDir = "";
  });

  afterEach(() => {
    if (ORIG_ENV === undefined) {
      delete process.env["NIMBUS_EMBEDDING_MODEL_DIR"];
    } else {
      process.env["NIMBUS_EMBEDDING_MODEL_DIR"] = ORIG_ENV;
    }
  });

  it("returns an Embedder with model + dims metadata", async () => {
    const embedder = await createLocalEmbedder({ cacheDir: "/tmp/test-cache" });
    expect(embedder.model).toBe("all-MiniLM-L6-v2");
    expect(embedder.dims).toBe(384);
  });

  it("uses options.cacheDir when NIMBUS_EMBEDDING_MODEL_DIR is unset", async () => {
    delete process.env["NIMBUS_EMBEDDING_MODEL_DIR"];
    await createLocalEmbedder({ cacheDir: "/tmp/explicit" });
    expect(mockEnv.cacheDir).toBe("/tmp/explicit");
  });

  it("uses NIMBUS_EMBEDDING_MODEL_DIR when set (overriding cacheDir)", async () => {
    process.env["NIMBUS_EMBEDDING_MODEL_DIR"] = "/override/cache";
    await createLocalEmbedder({ cacheDir: "/tmp/explicit" });
    expect(mockEnv.cacheDir).toBe("/override/cache");
  });

  it("falls through to options.cacheDir when env var is empty string", async () => {
    process.env["NIMBUS_EMBEDDING_MODEL_DIR"] = "";
    await createLocalEmbedder({ cacheDir: "/tmp/fallback" });
    expect(mockEnv.cacheDir).toBe("/tmp/fallback");
  });

  it("embed() returns row vectors with correct dims", async () => {
    const embedder = await createLocalEmbedder({ cacheDir: "/tmp/test" });
    mockPipelineFn.mockImplementation(async () => ({
      data: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]),
      dims: [2, 3] as const,
    }));
    const vectors = await embedder.embed(["hello", "world"]);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]?.length).toBe(3);
    expect(Array.from(vectors[0] ?? [])).toEqual([0.1, 0.2, 0.3]);
    expect(Array.from(vectors[1] ?? [])).toEqual([0.4, 0.5, 0.6]);
  });

  it("embed() returns empty array for empty input", async () => {
    const embedder = await createLocalEmbedder({ cacheDir: "/tmp/test" });
    const vectors = await embedder.embed([]);
    expect(vectors).toEqual([]);
    // The pipeline should NOT have been called for empty input.
    // (mockPipelineFn was called once during createLocalEmbedder setup,
    //  but embed([]) early-returns before invoking it again.)
    const callCountAfterEmpty = mockPipelineFn.mock.calls.length;
    expect(callCountAfterEmpty).toBe(0);
  });
});
```

- [ ] **Step 7: Run the test**

```bash
bun test packages/gateway/src/embedding/model.test.ts
```

Expected: green. If the `mock.module` call still collides somehow (unlikely with the unique target path, but verify), fall back to a raised watermark per spec rule 3.

- [ ] **Step 8: Run the full embedding test suite to verify no regression on `create-routing-runtime.test.ts`**

```bash
bun test packages/gateway/src/embedding/
```

Expected: all green. Specifically, `create-routing-runtime.test.ts` must still pass — it continues to mock `@xenova/transformers` directly, and the two mocks now target distinct paths.

- [ ] **Step 9: Confirm coverage**

```bash
bun run audit:coverage-floor:build-lcov
grep -A 3 "embedding/model.ts" coverage/lcov.info | head -10
```

Expected: ≥80%.

- [ ] **Step 10: Lint + commit**

```bash
bun run lint:fix
git add packages/gateway/src/embedding/load-transformer-pipeline.ts \
        packages/gateway/src/embedding/model.ts \
        packages/gateway/src/embedding/model.test.ts \
        scripts/coverage-floor/exclusions.ts \
        sonar-project.properties
git commit -m "$(cat <<'EOF'
test(embedding): refactor model.ts to load-transformer-pipeline shim + cover model.ts (Tier D retry)

Phase 5 commit 12 of 13. Resolves Phase 4's mock.module collision
between embedding/model.test.ts (would mock @xenova/transformers) and
embedding/create-routing-runtime.test.ts (already mocks the same package
under the same coverage build process).

Refactor:
- New embedding/load-transformer-pipeline.ts: 4-line shim wrapping the
  `await import("@xenova/transformers")` call.
- model.ts's createLocalEmbedder now calls loadTransformerPipeline()
  instead of the direct dynamic import. Public API unchanged.
- model.test.ts mocks "./load-transformer-pipeline.ts" - a unique target
  path that does not collide with create-routing-runtime.test.ts's
  @xenova/transformers mock.
- The new shim is added to EXCLUSIONS + sonar-project.properties (thin
  indirection, no executable logic of its own; same rationale as
  vault/ffi-ptr.ts).

~6 cases covering createLocalEmbedder constants, env-var precedence,
pipeline invocation, embed() row-vector conversion, and empty-input
early return.

13.51% -> >=80%.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13 (Commit 13): Drop raised entries + plan + spec + status row

**Files:**
- Modify: `docs/structure-audit/coverage-baseline.json` (drop raised entries; raise watermarks where partial)
- Add: `docs/superpowers/plans/2026-05-21-coverage-floor-phase-5.md` (this file — committed in earlier setup if following the rev-2 flow; if not, add here)
- Modify: `CLAUDE.md` + `GEMINI.md` (status row)

Note: The spec, spec review, and plan-review documents have **already been committed** earlier on this branch (`a26dce1f`, `2e8cbdda`, `6b9d8f03`). This commit adds the plan file ITSELF if not yet committed, plus the baseline drop and status rows.

- [ ] **Step 1: Confirm plan file is committed**

```bash
git log --oneline --all -- docs/superpowers/plans/2026-05-21-coverage-floor-phase-5.md
```

If the plan file was authored AFTER the spec/review commits (the rev-2 flow committed only spec + review docs, not the plan), it will need to be added in this commit.

- [ ] **Step 2: Run the coverage build + update-baseline helper**

```bash
bun run audit:coverage-floor:build-lcov
bun run audit:coverage-floor:update-baseline
```

This regenerates `coverage-baseline.json` with:
- Files that crossed 80% → dropped.
- Files that improved but remain <80% → watermark raised.
- Files unchanged → unchanged.

- [ ] **Step 3: Diff the baseline file and sanity-check**

```bash
git diff docs/structure-audit/coverage-baseline.json | head -200
```

Confirm visually:

- ~14 entries dropped (5 Tier A + 6 testable Tier B + 2 Tier C + 1 Tier D).
- 2 entries dropped via Task 2 already (platform/index.ts, vault/factory.ts).
- 6 stale entries dropped via Task 1 already.
- `embedding/model.ts` either dropped (≥80%) or watermark raised.
- `App.tsx` either dropped or watermark raised.
- Pinned files (CLI commands, client, SDK, mcp-connectors) all unchanged.

If any non-Phase-5-scope file's watermark shifted, do **not** revert blindly — investigate why (a real regression upstream is possible).

- [ ] **Step 4: Run the floor gate against the updated baseline**

```bash
bun run audit:coverage-floor
```

Expected: exit 0.

- [ ] **Step 5: Add the status row to CLAUDE.md + GEMINI.md**

Find the "Status:" paragraph in both files (under "**Status:** Phase 4 ✅ Complete · Phase 5…"). Append:

```
· Coverage floor Phase 5 ✅ (2026-05-21)
```

…in the same chronological position as the existing Phase 4 entry.

- [ ] **Step 6: Run the full PR-quality gate locally**

```bash
bun run typecheck
bun run lint
bun run audit:exclusion-parity
bun run audit:invariants
bun run audit:coverage-floor
bun run test:ci
```

All exit 0. If `test:ci` fails on a flaky test, re-run; if it fails reproducibly, fix before committing.

- [ ] **Step 7: Final commit**

```bash
git add docs/structure-audit/coverage-baseline.json \
        docs/superpowers/plans/2026-05-21-coverage-floor-phase-5.md \
        CLAUDE.md GEMINI.md
git commit -m "$(cat <<'EOF'
chore(coverage-floor): drop raised entries + Phase 5 plan + status row

Phase 5 commit 13 of 13. Drops ~14 raised entries from
coverage-baseline.json (and raises any partial-improvement watermarks).
Records the Phase 5 status row in CLAUDE.md + GEMINI.md. Adds the
implementation plan file.

Cumulative Phase 5 impact:
- 6 stale baseline housekeeping (commit 1)
- 2 structural exclusions added (commit 2)
- ~14 baseline files raised to >=80% (commits 3-12)
- 1 new structural exclusion (load-transformer-pipeline.ts, commit 12)
- Baseline: 116 -> ~94 entries

The Gateway baseline is now empty (or near-empty if any partial
watermark raise was needed). Remaining ~94 entries are entirely
outside the Gateway (51 CLI, 5 client, 4 SDK, 30 mcp-connectors)
packaged for Phase 6+.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Push branch + open PR

- [ ] **Step 1: Push branch**

```bash
git push -u origin dev/asafgolombek/coverage-floor-phase-5-2026-05-21
```

- [ ] **Step 2: Open PR via `gh`**

```bash
gh pr create \
  --title "test(coverage-floor): Phase 5 — Finish the Gateway" \
  --body "$(cat <<'EOF'
## Summary
- Raises ~14 gateway baseline entries above the 80% per-file coverage floor (5 Phase 4 partials + 6 pinned-file tests + 2 T2 PR 4 carryover + 1 Tier D retry).
- Adds 3 structural exclusions: `platform/index.ts` + `vault/factory.ts` (per-OS async dispatchers, parallel to `platform/sandbox/sandbox-runner.ts`) + `embedding/load-transformer-pipeline.ts` (thin shim introduced to resolve a mock.module collision).
- Drops 6 stale baseline entries that were already in structural exclusions (Phase 4 commit-1 housekeeping leftover).
- Drops baseline from 116 → ~94 entries.

After this PR the Gateway baseline is empty (or near-empty if the `embedding/model.ts` or `App.tsx` retry landed at a raised watermark instead of ≥80%). Remaining ~94 entries are entirely outside the Gateway (CLI commands, client, SDK, mcp-connectors) and packaged for Phase 6+.

Spec: `docs/superpowers/specs/2026-05-21-coverage-floor-phase-5-design.md`
External design review: `docs/superpowers/specs/2026-05-21-coverage-floor-phase-5-design-review.md`
Plan: `docs/superpowers/plans/2026-05-21-coverage-floor-phase-5.md`
Plan review: `docs/superpowers/plans/2026-05-21-coverage-floor-phase-5-review.md`

## Test plan
- [ ] `bun run audit:coverage-floor:build-lcov && bun run audit:coverage-floor` exits 0
- [ ] `bun run audit:exclusion-parity` exits 0
- [ ] `bun run audit:invariants` exits 0
- [ ] `bun run lint` + `bun run typecheck` exit 0
- [ ] `bun run test:ci` green on CI Linux (authoritative)
- [ ] No file currently above 80% drops below 80%
- [ ] The 6 explicitly-out-of-scope buckets (CLI commands, CLI lib, CLI misc, client, SDK, mcp-connectors) remain at their current baseline watermarks

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed; ready for review.

---

## Self-review checklist (run after writing this plan)

- [x] **Spec coverage:** Every section of the spec has a task — housekeeping (Task 1), Tier B exclusions (Task 2), Tier A partials (Task 3), small-file Tier B nudges (Tasks 4-6), harder Tier B (Tasks 7-10), Tier C (Task 11), Tier D retry (Task 12), baseline drop + plan commit (Task 13), PR open (Task 14).
- [x] **Placeholder scan:** No "TBD" / "TODO". Test cases described by behavior; where the actual surface depends on source-read (`install-from-local.ts`, `App.tsx`, `registry-fetcher.ts`), the plan explicitly says "adapt after Step 2 mapping" rather than leaving the engineer to guess.
- [x] **Type consistency:** Function and option names referenced match source files read during plan authoring (`startReadOnlyHttpServer`, `ReadOnlyHttpServerOptions.resolveDeploymentToken`, `createLocalEmbedder`, `LOCAL_EMBEDDING_MODEL_ID`, `MINIMUM_MODEL_VERSION`, `loadTransformerPipeline`, `removeStaleUnixSocketIfPresent`, `chmodListenSocketBestEffort`, `attachWin32Socket`, `startWin32NetServer`, `startBunUnixListener`, `createWindowsPaths`, `createDarwinPaths`, `createLinuxPaths`, `detectFallbackReason`, `currentFallbackEnv`).
- [x] **Commit count:** 13 commits as promised in the spec (1 housekeeping + 1 exclusions + 10 test commits + 1 final cleanup = 13; Task 14 opens the PR, not a commit).
- [x] **Carry-forwards present:** Pre-implementation guardrails + Test hygiene sections mirror Phase 4's load-bearing patterns and incorporate the external-design-review fixes.
- [x] **`build-lcov` semantics explicit:** Pre-implementation guardrails state that `bun test --coverage` per package shares a single process between colocated and `test/integration/` files. Task 12 is built on that understanding, not on the broken "isolated test process" hypothesis from rev-1 of the self-review.
