# Coverage Floor Phase 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise ~33 gateway+near-floor baseline entries above the 80% per-file line-coverage floor and move 7 type-only/worker-entry files to structural exclusions, dropping the baseline from 140 → ~100 entries in a single PR.

**Spec:** [`docs/superpowers/specs/2026-05-20-coverage-floor-phase-4-design.md`](../specs/2026-05-20-coverage-floor-phase-4-design.md)

**Architecture:** Single PR with 16 commits ordered low-risk → high-risk: structural exclusions first, near-floor nudges second, mid-range and real-investment tiers last. No new shared harness — reuse Phase 2's `connector-sync-harness.ts` and Phase 3's `rpc-harness.ts` where applicable. Tests are colocated next to source files per Phase 3 precedent (e.g. `db/verify.test.ts` lives next to `db/verify.ts`).

**Tech Stack:** Bun v1.2+ test runner, `bun:test`, `bun:sqlite`, `MockVault` from `@nimbus-dev/sdk/testing`, Biome lint.

**Branch:** `dev/asafgolombek/coverage-floor-phase-4-2026-05-21`
**Worktree:** `.worktrees/coverage-floor-phase-4-2026-05-21/`
**Base commit:** `6461015e` (PR #370, Phase 3B-rest merge)

---

## File Map

**Created (test files, colocated):**
- `packages/gateway/src/agents/impact.test.ts` — extend existing if present
- `packages/gateway/src/connectors/user-mcp-store.test.ts`
- `packages/gateway/src/platform/assemble.test.ts`
- `packages/gateway/src/auth/oauth-vault-tokens.test.ts`
- `packages/gateway/src/config/telemetry-toml.test.ts`
- `packages/gateway/src/ipc/http-write-routes.test.ts`
- `packages/gateway/src/index/item-list-query.test.ts`
- `packages/gateway/src/connectors/sync-iso-helpers.test.ts`
- `packages/gateway/src/people/parse-from-header.test.ts`
- `packages/gateway/src/connectors/lazy-mesh/tool-map.test.ts`
- `packages/gateway/src/connectors/filesystem-v2-sync.test.ts`
- `packages/gateway/src/platform/register-user-mcp-sync.test.ts`
- `packages/cli/src/lib/interactive-ipc-handlers.test.ts`
- `packages/cli/src/tui/test-helpers/stub-client.test.ts`
- `packages/sdk/src/contract-tests.test.ts`
- `packages/gateway/src/db/verify.test.ts`
- `packages/gateway/src/config.test.ts`
- `packages/gateway/src/connectors/connector-vault.test.ts`
- `packages/gateway/src/connectors/connector-catalog.test.ts`
- `packages/gateway/src/auth/notion-access-token.test.ts`
- `packages/gateway/src/connectors/lazy-mesh/mesh.test.ts`
- `packages/gateway/src/connectors/user-mcp-sync.test.ts`
- `packages/gateway/src/embedding/worker-bridge.test.ts`
- `packages/gateway/src/db/backups-list.test.ts`
- `packages/gateway/src/connectors/sync-watermark-cursor-v1.test.ts`
- `packages/gateway/src/telemetry/flush-scheduler.test.ts`
- `packages/gateway/src/auth/slack-access-token.test.ts`
- `packages/gateway/src/voice/tts.test.ts`
- `packages/gateway/src/voice/wake-word.test.ts`
- `packages/gateway/src/llm/registry.test.ts`
- `packages/gateway/src/config/session-toml.test.ts`
- `packages/gateway/src/platform/worker-security.test.ts`
- `packages/gateway/src/platform/gateway-state-file.test.ts`
- `packages/gateway/src/embedding/create-embedding-runtime.test.ts`
- `packages/gateway/src/embedding/model.test.ts`

Some test files above may already exist (e.g. `agents/impact.test.ts` is likely present given the file is at 77.81%). In those cases the task adds new cases rather than creating a new file.

**Modified:**
- `scripts/coverage-floor/exclusions.ts` — add 7 new exact-path entries
- `sonar-project.properties` — mirror the same 7 entries
- `docs/structure-audit/coverage-baseline.json` — drop raised entries, raise watermarks where partial
- `CLAUDE.md` + `GEMINI.md` — add status row under "Phase 5 (Extended Surface)" line
- This plan file (`docs/superpowers/plans/2026-05-20-coverage-floor-phase-4.md`)

---

## Pre-implementation guardrails

These are non-negotiable per Phase 3A/3B-rest carry-forwards (see spec §"Carry-forwards"):

- Local Windows lcov diverges from CI Linux on Phase 2B-pinned + Windows-regression files — **CI Linux is authoritative**. Do not chase local-only deltas.
- `db.run` / `db.exec` in test files is fine (static auditor skips `*.test.ts`).
- `exactOptionalPropertyTypes: true` — pass no property instead of `prop: undefined`.
- `bun:sqlite` / `bun:test` IDE false positives — ignore; project-root typecheck is authoritative.
- Run `bun run lint:fix` before every commit.

---

## Test hygiene (cross-cutting rules)

Apply these patterns in any task that mutates global state, dynamic imports, or subprocess APIs. Skipping these is the most common cause of CI flakiness in this kind of coverage program.

### Env-var and global state restoration

Any task that mutates `process.env`, `globalThis`, or any other global **must** restore the original value in `afterEach`. The pattern:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

describe("…", () => {
  const ORIGINAL_ENV = process.env.SOME_VAR;
  beforeEach(() => {
    process.env.SOME_VAR = "test-value";
  });
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.SOME_VAR;
    } else {
      process.env.SOME_VAR = ORIGINAL_ENV;
    }
  });
});
```

For `globalThis.<prop>` stubs done via `Object.defineProperty`, capture the original descriptor and restore it:

```typescript
let originalOriginDescriptor: PropertyDescriptor | undefined;
beforeEach(() => {
  originalOriginDescriptor = Object.getOwnPropertyDescriptor(globalThis, "origin");
  Object.defineProperty(globalThis, "origin", { value: "https://example", configurable: true });
});
afterEach(() => {
  if (originalOriginDescriptor === undefined) {
    delete (globalThis as Record<string, unknown>).origin;
  } else {
    Object.defineProperty(globalThis, "origin", originalOriginDescriptor);
  }
});
```

**Applies to:** Task 2 (`platform/assemble.ts` — `XDG_CONFIG_HOME` mutation), Task 6 (`auth/notion-access-token.ts` — `fetch` stub), Task 13 (`auth/slack-access-token.ts` — `fetch` stub), Task 14 (`voice/*` — `Bun.spawn` stub), Task 15 (`platform/worker-security.ts` — `globalThis.origin`; `platform/gateway-state-file.ts` — `NIMBUS_GATEWAY_LOG_PATH`; `embedding/create-embedding-runtime.ts` — `NIMBUS_SKIP_EMBEDDING_RUNTIME` + `OPENAI_API_KEY`).

### `Bun.spawn` mock surface

When stubbing `Bun.spawn`, the mocked return object must implement enough of the `Subprocess` interface to keep the consumer code from throwing on unfamiliar shapes. Minimum surface for the voice modules:

```typescript
type MockedSubprocess = {
  stdout: ReadableStream | AsyncIterable<Uint8Array>;
  stderr: ReadableStream | AsyncIterable<Uint8Array>;
  exited: Promise<number>;          // resolves to exit code (0 = success)
  kill(signal?: number | string): void;
  killed: boolean;
};
```

Use a small helper `createMockSubprocess({ exitCode, stdout, stderr })` in the test file to keep call sites short.

**Applies to:** Task 14 (`voice/tts.ts`, `voice/wake-word.ts`).

### Dynamic-import mocking with `mock.module`

When stubbing `await import("…")`, the `mock.module(...)` call **must appear at the top of the test file, before the source module is imported**. Bun resolves the dynamic-import target eagerly when the source module is first evaluated; installing the mock after that point produces a real-module reference inside the source.

```typescript
import { mock } from "bun:test";

// Top of file, BEFORE any import of the module under test.
mock.module("@xenova/transformers", () => ({
  env: { cacheDir: "" },
  pipeline: async () => async () => ({ data: new Float32Array([1, 2, 3]), dims: [1, 3] }),
}));

// Now safe to import the source.
import { createLocalEmbedder } from "./model.ts";
```

If a test needs *different* mock values per case, prefer a single mock with a mutable inner factory (set values via `beforeEach`) over re-registering the mock per test.

If the dynamic-import mock proves fragile (e.g. the source module captures the import at module-load time before the mock can install), fall back to partial coverage + raised watermark per spec rule 3.

**Applies to:** Task 15 (`embedding/model.ts`).

---

## Task 0: Worktree setup + stale cleanup

**Files:** `.worktrees/coverage-floor-phase-4-2026-05-21/` (created)

- [ ] **Step 1: Remove stale Phase 3B-rest worktree residue**

```bash
rm -rf .worktrees/coverage-floor-phase-3b-rest-2026-05-20/
```

Expected: directory gone or "No such file" (already cleaned).

- [ ] **Step 2: Create Phase 4 worktree on a new branch from main@6461015e**

```bash
git worktree add -b dev/asafgolombek/coverage-floor-phase-4-2026-05-21 \
  .worktrees/coverage-floor-phase-4-2026-05-20 6461015e
```

Expected: "Preparing worktree (new branch …)" then "HEAD is now at 6461015e".

- [ ] **Step 3: Verify worktree and switch into it**

```bash
cd .worktrees/coverage-floor-phase-4-2026-05-20
git status
git rev-parse HEAD
```

Expected: clean tree, branch = phase-4, HEAD = 6461015e.

- [ ] **Step 4: Bring spec + plan into the worktree**

The spec (`docs/superpowers/specs/2026-05-20-coverage-floor-phase-4-design.md`) and this plan file were authored on `main`. Copy them into the worktree so they ship as part of the PR.

```bash
cp ../../docs/superpowers/specs/2026-05-20-coverage-floor-phase-4-design.md \
   docs/superpowers/specs/
cp ../../docs/superpowers/plans/2026-05-20-coverage-floor-phase-4.md \
   docs/superpowers/plans/
git add docs/superpowers/
```

Defer the commit — the spec + plan land together with commit 16 (the final cleanup commit) so all PR documentation lives in one place.

- [ ] **Step 5: Install deps and confirm baseline tests pass**

```bash
bun install
bun run typecheck
bun run lint
bun run audit:coverage-floor:build-lcov
bun run audit:coverage-floor
```

Expected: all four exit 0 (the floor gate is green at baseline by definition).

---

## Task 1 (Commit 1): Structural exclusions for 7 type-only / worker-entry files

**Files:**
- Modify: `scripts/coverage-floor/exclusions.ts`
- Modify: `sonar-project.properties`

- [ ] **Step 1: Read the current exclusions registry**

```bash
cat scripts/coverage-floor/exclusions.ts
```

Note where the `// Type-only files…` block ends and where new entries should be inserted.

- [ ] **Step 2: Add 7 exact-path entries to `EXCLUSIONS`**

Add the following entries to `EXCLUSIONS` in `scripts/coverage-floor/exclusions.ts`, grouped by rationale, with explanatory comments matching the existing style:

```typescript
  // Pure re-export modules — `export { ... } from "./..."` produces no
  // executable code after TypeScript erasure. Same precedent as
  // packages/gateway/src/platform/sandbox/index.ts above.
  { kind: "exact", path: "packages/gateway/src/connectors/index.ts" },

  // Pure type-only files that don't match the `**/*types*.ts` basename
  // regex but follow the same exemption rationale — zero executable
  // statements after TS erasure. Same precedent as
  // packages/gateway/src/connectors/lazy-mesh/slot.ts above.
  { kind: "exact", path: "packages/gateway/src/embedding/embedding-runtime.ts" },
  { kind: "exact", path: "packages/gateway/src/index/ranked-item.ts" },
  { kind: "exact", path: "packages/gateway/src/vault/nimbus-vault.ts" },

  // Bun Worker entry points — top-level `onmessage` handler; untestable
  // in-process. The observable contract (message shape + side effects)
  // is exercised by the worker's consumer in the parent process.
  { kind: "exact", path: "packages/gateway/src/db/query-guard-worker.ts" },
  { kind: "exact", path: "packages/gateway/src/embedding/embedding-worker.ts" },

  // Windows-only FFI helper — only imported by vault/win32.ts, so on
  // Ubuntu CI lcov it's never loaded. Same per-OS shape as the existing
  // vault/{win32,darwin,linux}.ts exclusions above.
  { kind: "exact", path: "packages/gateway/src/vault/ffi-ptr.ts" },
```

- [ ] **Step 3: Mirror the same 7 paths in `sonar-project.properties`**

Find the `sonar.coverage.exclusions=` line. Append the 7 paths, comma-separated. Preserve existing entries.

```bash
grep -n "sonar.coverage.exclusions" sonar-project.properties
```

Then edit the file to add (preserving existing items): the same 7 forward-slash paths.

- [ ] **Step 4: Run the parity check**

```bash
bun run audit:exclusion-parity
```

Expected: exit 0 (`sonar-project.properties` and `exclusions.ts` agree).

- [ ] **Step 5: Run the floor gate against fresh lcov**

```bash
bun run audit:coverage-floor:build-lcov
bun run audit:coverage-floor
```

Expected: exit 0; baseline file unchanged (the 7 excluded files were 0% baselines but the exclusion registry takes precedence over the baseline).

- [ ] **Step 6: Drop the 7 entries from `coverage-baseline.json`**

The excluded files no longer need baseline entries. Remove these 7 lines from `docs/structure-audit/coverage-baseline.json`:

```
packages/gateway/src/connectors/index.ts
packages/gateway/src/db/query-guard-worker.ts
packages/gateway/src/embedding/embedding-runtime.ts
packages/gateway/src/embedding/embedding-worker.ts
packages/gateway/src/index/ranked-item.ts
packages/gateway/src/vault/ffi-ptr.ts
packages/gateway/src/vault/nimbus-vault.ts
```

- [ ] **Step 7: Re-run floor gate to confirm baseline still consistent**

```bash
bun run audit:coverage-floor
```

Expected: exit 0.

- [ ] **Step 8: Lint + commit**

```bash
bun run lint:fix
git add scripts/coverage-floor/exclusions.ts sonar-project.properties \
        docs/structure-audit/coverage-baseline.json
git commit -m "chore(coverage-floor): add 7 structural exclusions for type-only / worker-entry files

Phase 4 commit 1 of 16. Adds exclusions for:
- connectors/index.ts (pure re-export)
- embedding/embedding-runtime.ts (type-only)
- index/ranked-item.ts (type-only)
- vault/nimbus-vault.ts (interface-only)
- db/query-guard-worker.ts (Bun Worker entry)
- embedding/embedding-worker.ts (Bun Worker entry)
- vault/ffi-ptr.ts (Windows-only FFI helper, parallel to vault/win32.ts)

Same precedent as the existing platform/sandbox/index.ts, lazy-mesh/slot.ts,
and vault/{win32,darwin,linux}.ts exclusions. Drops 7 entries from
coverage-baseline.json.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2 (Commit 2): Tier A — 12 gateway near-floor nudges

**Files (modified or created, one per file below):**

| Source file | Current | Target |
|---|---|---|
| `packages/gateway/src/agents/impact.ts` | 77.81% | ≥80% |
| `packages/gateway/src/connectors/user-mcp-store.ts` | 77.97% | ≥80% |
| `packages/gateway/src/platform/assemble.ts` | 77.75% | ≥80% |
| `packages/gateway/src/auth/oauth-vault-tokens.ts` | 76.6% | ≥80% |
| `packages/gateway/src/config/telemetry-toml.ts` | 76.64% | ≥80% |
| `packages/gateway/src/ipc/http-write-routes.ts` | 79.38% | ≥80% |
| `packages/gateway/src/index/item-list-query.ts` | 75% | ≥80% |
| `packages/gateway/src/connectors/sync-iso-helpers.ts` | 75% | ≥80% |
| `packages/gateway/src/people/parse-from-header.ts` | 74.39% | ≥80% |
| `packages/gateway/src/connectors/lazy-mesh/tool-map.ts` | 73.91% | ≥80% |
| `packages/gateway/src/connectors/filesystem-v2-sync.ts` | 73.58% | ≥80% |
| `packages/gateway/src/platform/register-user-mcp-sync.ts` | 75% | ≥80% |

For each file, the workflow is identical:

- [ ] **Step A: Read the source file and identify uncovered lines**

```bash
bun run audit:coverage-floor:build-lcov 2>&1 | tail -30
# Read the source file in question; cross-reference with coverage gaps.
```

The lcov report lives at `coverage/lcov.info` after the build step. Open it and grep for the file's `SF:` block — the `DA:<line>,0` entries are uncovered.

- [ ] **Step B: Find or create the colocated test file**

```bash
ls packages/gateway/src/<dir>/<name>.test.ts 2>/dev/null || echo "create new"
```

If it exists, append new `it(...)` cases under the existing `describe(...)`. If not, create with the standard skeleton:

```typescript
import { describe, expect, it } from "bun:test";
import { /* exports under test */ } from "./<name>.ts";

describe("<module name>", () => {
  it("<case>", () => {
    // ...
  });
});
```

- [ ] **Step C: Write 1–3 new cases targeting the uncovered branches**

The case names and surfaces per file:

- `agents/impact.ts` — 2 cases: empty-corpus path (no `git_repo`s returned) + LLM-disabled synthesis fallback (covers `_lib/render.ts` deterministic path).
- `connectors/user-mcp-store.ts` — 2 cases: malformed JSON deserialization branch + empty-store list call (returns empty array, exercises null-checks).
- `platform/assemble.ts` — 2 cases: missing-data-dir env var (fallback path) + the `assembleConfigDir` branch with `XDG_CONFIG_HOME` unset on Linux.
- `auth/oauth-vault-tokens.ts` — 3 cases: refresh-failed error branch + valid-token cache hit + token-expired refresh path.
- `config/telemetry-toml.ts` — 2 cases: comment-only file → defaults + `[telemetry]` with all booleans false.
- `ipc/http-write-routes.ts` — 1 case: 405 path (method not allowed on a known route) — currently uncovered.
- `index/item-list-query.ts` — 2 cases: `service=*` wildcard + cursor-after-last-row empty result.
- `connectors/sync-iso-helpers.ts` — 2 cases: invalid-iso-string passthrough + boundary at `Number.MAX_SAFE_INTEGER`.
- `people/parse-from-header.ts` — 2 cases: malformed-quoted-name (unbalanced quotes) + multiple-comma-separated addresses (only first parsed).
- `connectors/lazy-mesh/tool-map.ts` — 2 cases: tool with hyphenated name → snake-case normalization + collision-on-prefix returns first match.
- `connectors/filesystem-v2-sync.ts` — Use `connector-sync-harness.ts`. 1–2 cases for the directory-not-readable error branch and the symlink-cycle detector.
- `platform/register-user-mcp-sync.ts` — 1–2 cases: vault-key-missing path + happy-path registration assertion on the scheduler.

- [ ] **Step D: Run the per-file test**

```bash
bun test packages/gateway/src/<dir>/<name>.test.ts
```

Expected: all green, including pre-existing cases.

- [ ] **Step E: Repeat for the remaining 11 files in the table**

After all 12 files are done:

- [ ] **Step F: Run the gateway test suite + floor gate**

```bash
bun test
bun run audit:coverage-floor:build-lcov
bun run audit:coverage-floor
```

Expected: tests green. Floor gate may still flag "must-remove" violations because the baseline hasn't been updated yet — that's fine; we drop entries in commit 16.

- [ ] **Step G: Lint + commit**

```bash
bun run lint:fix
git add packages/gateway/src/
git commit -m "test(near-floor): nudge 12 gateway files above 80% (Tier A)

Phase 4 commit 2 of 16. ~24 new cases across 12 files:
agents/impact, connectors/user-mcp-store, platform/assemble,
auth/oauth-vault-tokens, config/telemetry-toml, ipc/http-write-routes,
index/item-list-query, connectors/sync-iso-helpers,
people/parse-from-header, connectors/lazy-mesh/tool-map,
connectors/filesystem-v2-sync, platform/register-user-mcp-sync.

Each file raised from 73-79% to >=80%.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3 (Commit 3): Tier A — 3 non-gateway near-floor nudges

**Files:**

| Source file | Current | Target | Approach |
|---|---|---|---|
| `packages/cli/src/lib/interactive-ipc-handlers.ts` | 79.34% | ≥80% | One extra case in the existing test file |
| `packages/cli/src/tui/test-helpers/stub-client.ts` | 79.49% | ≥80% | One extra case |
| `packages/sdk/src/contract-tests.ts` | 78.43% | ≥80% | One or two extra cases |

- [ ] **Step 1: For each file, find the existing test (likely present) and add the minimum cases needed**

The case names per file:

- `cli/src/lib/interactive-ipc-handlers.ts` — 1 case: handler-not-registered fallback path.
- `cli/src/tui/test-helpers/stub-client.ts` — 1 case: unstubbed-method default behavior.
- `sdk/src/contract-tests.ts` — 1–2 cases: missing-required-field assertion in `runContractTests` + the per-tool HITL assertion branch.

- [ ] **Step 2: Run each test file**

```bash
bun test packages/cli/src/lib/interactive-ipc-handlers.test.ts
bun test packages/cli/src/tui/test-helpers/stub-client.test.ts
bun test packages/sdk/src/contract-tests.test.ts
```

Expected: all green.

- [ ] **Step 3: Run global lint + the floor gate (informational only)**

```bash
bun run lint:fix
```

- [ ] **Step 4: Commit**

```bash
git add packages/cli/ packages/sdk/
git commit -m "test(near-floor): nudge cli + sdk near-floor files above 80%

Phase 4 commit 3 of 16. ~3 new cases:
- cli/src/lib/interactive-ipc-handlers.ts (79.34% -> >=80%)
- cli/src/tui/test-helpers/stub-client.ts (79.49% -> >=80%)
- sdk/src/contract-tests.ts (78.43% -> >=80%)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4 (Commit 4): Tier B — db/verify.ts + config.ts

**Files:**
- `packages/gateway/src/db/verify.ts` (70.06% → ≥80%)
- `packages/gateway/src/config.ts` (69.89% → ≥80%)

- [ ] **Step 1: Read each source file, identify uncovered branches**

```bash
cat packages/gateway/src/db/verify.ts
cat packages/gateway/src/config.ts
```

- [ ] **Step 2: Write cases for `db/verify.ts`**

Approximate 4 cases targeting the uncovered branches:
- Integrity-check failure path (corrupt `quick_check` result).
- Missing-table detection (drop a known table in the fixture DB before invoking verify).
- FTS5 shadow-orphan check.
- Schema-version-too-new branch.

Use a tmp-dir + fresh `Database` instance:

```typescript
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

let tmpDir: string;
let db: Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "nimbus-verify-"));
  db = new Database(join(tmpDir, "nimbus.db"));
  // run a minimal subset of migrations, or load a fixture
});

afterEach(() => {
  db.close();
});
```

- [ ] **Step 3: Write cases for `config.ts`**

Approximate 4 cases for `config.ts`:
- Profile-prefix vault key resolution (active profile applied to key prefix).
- `getConfigPath` env-override path.
- Invalid-TOML fallback to defaults.
- Empty-config-dir fresh-start path.

- [ ] **Step 4: Run both tests**

```bash
bun test packages/gateway/src/db/verify.test.ts \
         packages/gateway/src/config.test.ts
```

Expected: green.

- [ ] **Step 5: Lint + commit**

```bash
bun run lint:fix
git add packages/gateway/src/db/verify.ts \
        packages/gateway/src/db/verify.test.ts \
        packages/gateway/src/config.ts \
        packages/gateway/src/config.test.ts
git commit -m "test(db,config): raise db/verify.ts + config.ts above 80% (Tier B)

Phase 4 commit 4 of 16. ~8 new cases:
- db/verify.ts: integrity-fail, missing-table, fts5-orphan, schema-newer
- config.ts: profile-prefix vault key, env override, invalid TOML, empty dir

70.06%/69.89% -> >=80%.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5 (Commit 5): Tier B — connector-vault.ts + connector-catalog.ts

**Files:**
- `packages/gateway/src/connectors/connector-vault.ts` (67.74% → ≥80%)
- `packages/gateway/src/connectors/connector-catalog.ts` (64.71% → ≥80%)

- [ ] **Step 1: Read both source files**

```bash
cat packages/gateway/src/connectors/connector-vault.ts
cat packages/gateway/src/connectors/connector-catalog.ts
```

- [ ] **Step 2: Write cases for `connector-vault.ts`**

Use `MockVault`. Approximate 5 cases:
- `perServiceOAuthVaultKey` with each supported service (parametric over the manifest).
- `writePerServiceOAuthKey` round-trip.
- `migrateToPerServiceOAuthKeys` — old-key-present branch + new-key-already-set short-circuit.
- `readConnectorSecret` for a service with no manifest entry.
- `clearConnectorVaultSecretKeys` — verify all keys removed for a service.

- [ ] **Step 3: Write cases for `connector-catalog.ts`**

Approximate 5 cases:
- Catalog entry for each first-party connector (parametric).
- Unknown-service lookup returns `undefined`.
- Manifest validation rejects missing required fields.
- Sort/order stability on `listConnectors()`.
- Idempotent re-registration.

- [ ] **Step 4: Run both tests + lint + commit**

```bash
bun test packages/gateway/src/connectors/connector-vault.test.ts \
         packages/gateway/src/connectors/connector-catalog.test.ts
bun run lint:fix
git add packages/gateway/src/connectors/connector-vault.{ts,test.ts} \
        packages/gateway/src/connectors/connector-catalog.{ts,test.ts}
git commit -m "test(connectors): raise connector-vault + connector-catalog above 80% (Tier B)

Phase 4 commit 5 of 16. ~10 new cases covering per-service OAuth key
routing, migration, secret reads/clears, and catalog lookup.

67.74%/64.71% -> >=80%.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6 (Commit 6): Tier B — auth/notion-access-token.ts

**Files:**
- `packages/gateway/src/auth/notion-access-token.ts` (62.07% → ≥80%)

- [ ] **Step 1: Read the source**

```bash
cat packages/gateway/src/auth/notion-access-token.ts
```

- [ ] **Step 2: Write cases**

Approximate 4 cases:
- Vault-key-missing → returns `null`.
- Token-expired → refresh path triggers `fetch` mock + writes back to vault.
- Refresh-error → returns `null` (best-effort).
- Cache-hit fast path (no network call).

Use `MockVault` + stub `globalThis.fetch` for the refresh branch.

- [ ] **Step 3: Run + lint + commit**

```bash
bun test packages/gateway/src/auth/notion-access-token.test.ts
bun run lint:fix
git add packages/gateway/src/auth/notion-access-token.{ts,test.ts}
git commit -m "test(auth): raise notion-access-token above 80% (Tier B)

Phase 4 commit 6 of 16. ~4 new cases covering vault-miss, refresh-success,
refresh-error, and cache-hit branches.

62.07% -> >=80%.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7 (Commit 7): Tier B — lazy-mesh/mesh.ts (split per review)

**Files:**
- `packages/gateway/src/connectors/lazy-mesh/mesh.ts` (60.83% → ≥80%)

This is the largest Tier B file and isolated into its own commit for surgical revertability per the design review.

- [ ] **Step 1: Read the source + identify the spawn/dispatch surface**

```bash
cat packages/gateway/src/connectors/lazy-mesh/mesh.ts
```

Note the I11 wrapping site at line 397 (`wrapToolOutput` call) — tests must not regress that wiring.

- [ ] **Step 2: Write cases using existing MockMcpClient / lazy-mesh test helpers**

Approximate 8 cases:
- Lazy spawn of a connector on first tool call.
- Idempotent spawn — second call reuses the running process.
- Health-degraded transition after N consecutive errors.
- Tool-list cache invalidation on connector restart.
- `wrapToolOutput` envelope present on every LLM-facing tool result (I11 regression guard).
- Manifest-not-found error surface.
- Spawn failure → connector marked `error` + audit row written.
- Graceful shutdown drains in-flight calls.

- [ ] **Step 3: Run the test**

```bash
bun test packages/gateway/src/connectors/lazy-mesh/mesh.test.ts
```

Expected: green. If coverage doesn't reach 80% after this commit, raise the watermark in `coverage-baseline.json` to the new measured value (do not regress) and document the residual in commit 16's PR description.

- [ ] **Step 4: Lint + commit**

```bash
bun run lint:fix
git add packages/gateway/src/connectors/lazy-mesh/mesh.{ts,test.ts}
git commit -m "test(lazy-mesh): raise mesh.ts above 80% (Tier B, isolated)

Phase 4 commit 7 of 16. ~8 new cases covering lazy spawn, health
transitions, tool-list cache, wrapToolOutput envelope (I11 regression
guard), and shutdown drain.

60.83% -> >=80%.

Split from commit 6 per design review for surgical revertability — mesh.ts
is the highest-mock-surface Tier B file.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8 (Commit 8): Tier C — connectors/user-mcp-sync.ts

**Files:**
- `packages/gateway/src/connectors/user-mcp-sync.ts` (52.63% → ≥80%)

Use `connector-sync-harness.ts` per spec §"Test Infrastructure".

- [ ] **Step 1: Read source + harness**

```bash
cat packages/gateway/src/connectors/user-mcp-sync.ts
cat packages/gateway/test/helpers/connector-sync-harness.ts
```

- [ ] **Step 2: Write cases**

Approximate 6 cases:
- First sync (no watermark) — full backfill.
- Incremental sync — items since watermark.
- Empty MCP tool response — no upserts, sync token still advances.
- Sync failure → connector health transitions to `error`.
- Concurrent-sync re-entry guard (second call short-circuits).
- Tool-permission-denied → returns `unauthenticated` health.

- [ ] **Step 3: Run + lint + commit**

```bash
bun test packages/gateway/src/connectors/user-mcp-sync.test.ts
bun run lint:fix
git add packages/gateway/src/connectors/user-mcp-sync.{ts,test.ts}
git commit -m "test(connectors): cover user-mcp-sync via connector-sync-harness (Tier C)

Phase 4 commit 8 of 16. ~6 new cases using the Phase 2 harness.

52.63% -> >=80%.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9 (Commit 9): Tier C — embedding/worker-bridge.ts

**Files:**
- `packages/gateway/src/embedding/worker-bridge.ts` (46.49% → ≥80%)

- [ ] **Step 1: Read source**

```bash
cat packages/gateway/src/embedding/worker-bridge.ts
```

- [ ] **Step 2: Write cases**

Approximate 4 cases (mock the `Worker` constructor with `mock.module(...)`):
- Happy-path init → `ready` message → embed text → result echoes back.
- Init-error → `tryCreateEmbeddingWorkerBridge` returns `null` (degraded path).
- `embed_texts` rejects when worker emits `{ ok: false, error: "…" }`.
- `embed_item` enqueues into the embed chain (serial execution under concurrent calls).

- [ ] **Step 3: Run + lint + commit**

```bash
bun test packages/gateway/src/embedding/worker-bridge.test.ts
bun run lint:fix
git add packages/gateway/src/embedding/worker-bridge.{ts,test.ts}
git commit -m "test(embedding): cover worker-bridge happy + degraded paths (Tier C)

Phase 4 commit 9 of 16. ~4 new cases with mocked Worker ctor covering
init-ready, init-error, embed rejection, and chained embed_item ordering.

46.49% -> >=80% (raise watermark if not reached; document in PR body).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10 (Commit 10): Tier C — db/backups-list.ts

**Files:**
- `packages/gateway/src/db/backups-list.ts` (40.91% → ≥80%)

- [ ] **Step 1: Read source**

```bash
cat packages/gateway/src/db/backups-list.ts
```

- [ ] **Step 2: Write cases (tmp dir + real fs)**

Approximate 4 cases:
- Empty backups dir → empty list.
- Mixed scheduled + manual snapshots → sorted by timestamp descending. **Determinism note:** the source orders by either filename-encoded timestamp or `fs.statSync(...).mtimeMs`. Inspect `db/backups-list.ts` to confirm which; if it parses the filename, encode timestamps directly in the test fixture filenames (e.g. `pre-migration-V29-1700000000000.db`, `pre-migration-V30-1700000001000.db`). If it stats, call `fs.utimesSync(path, atime, mtime)` after creating each fixture file with explicitly chosen `mtime` values at least 10 ms apart. Never rely on tight-loop create order — it races on Windows + macOS NFS-style filesystems.
- Malformed filename ignored (not in result).
- Non-existent backups dir → empty list (not an error).

- [ ] **Step 3: Run + lint + commit**

```bash
bun test packages/gateway/src/db/backups-list.test.ts
bun run lint:fix
git add packages/gateway/src/db/backups-list.{ts,test.ts}
git commit -m "test(db): cover backups-list listing + filtering (Tier C)

Phase 4 commit 10 of 16. ~4 new cases with tmp-dir fixtures covering
empty, mixed-snapshot-types, malformed-filename, and missing-dir paths.

40.91% -> >=80%.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11 (Commit 11): Tier C — sync-watermark-cursor-v1.ts

**Files:**
- `packages/gateway/src/connectors/sync-watermark-cursor-v1.ts` (34.62% → ≥80%)

- [ ] **Step 1: Read source**

```bash
cat packages/gateway/src/connectors/sync-watermark-cursor-v1.ts
```

- [ ] **Step 2: Write cases**

Approximate 3 cases:
- Encode/decode round-trip for a typical watermark.
- Schema-version mismatch on decode → returns `null` (forces full re-sync).
- Empty/invalid input → returns `null`.

- [ ] **Step 3: Run + lint + commit**

```bash
bun test packages/gateway/src/connectors/sync-watermark-cursor-v1.test.ts
bun run lint:fix
git add packages/gateway/src/connectors/sync-watermark-cursor-v1.{ts,test.ts}
git commit -m "test(connectors): cover sync-watermark-cursor-v1 (Tier C)

Phase 4 commit 11 of 16. ~3 new cases covering encode/decode round-trip,
schema-version mismatch, and invalid-input fallback.

34.62% -> >=80%.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12 (Commit 12): Tier C — telemetry/flush-scheduler.ts

**Files:**
- `packages/gateway/src/telemetry/flush-scheduler.ts` (33.6% → ≥80%)

- [ ] **Step 1: Read source**

```bash
cat packages/gateway/src/telemetry/flush-scheduler.ts
```

- [ ] **Step 2: Write cases (use a manual clock — inject `now: () => number` or stub `setTimeout`)**

Approximate 5 cases:
- First-flush-after-N-ms timer fires.
- Re-arm interval — second flush at next tick.
- Disabled-telemetry → no flush (collector unused).
- `flushNow()` interrupts the timer and re-arms.
- Shutdown clears the timer.

- [ ] **Step 3: Run + lint + commit**

```bash
bun test packages/gateway/src/telemetry/flush-scheduler.test.ts
bun run lint:fix
git add packages/gateway/src/telemetry/flush-scheduler.{ts,test.ts}
git commit -m "test(telemetry): cover flush-scheduler with fake timers (Tier C)

Phase 4 commit 12 of 16. ~5 new cases with manual-clock injection
covering first-flush, re-arm, disabled, flushNow, and shutdown.

33.6% -> >=80%.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13 (Commit 13): Tier C — auth/slack-access-token.ts

**Files:**
- `packages/gateway/src/auth/slack-access-token.ts` (30.77% → ≥80%)

- [ ] **Step 1: Read source**

```bash
cat packages/gateway/src/auth/slack-access-token.ts
```

- [ ] **Step 2: Write cases**

Same shape as the Notion commit (Task 6). Approximate 4 cases:
- Vault-miss → `null`.
- Expired → refresh fetch → writes new token to vault.
- Refresh error → `null`.
- Cache-hit fast path.

- [ ] **Step 3: Run + lint + commit**

```bash
bun test packages/gateway/src/auth/slack-access-token.test.ts
bun run lint:fix
git add packages/gateway/src/auth/slack-access-token.{ts,test.ts}
git commit -m "test(auth): cover slack-access-token (Tier C)

Phase 4 commit 13 of 16. ~4 new cases mirroring the notion-access-token
shape (vault-miss, refresh, error, cache-hit).

30.77% -> >=80%.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 14 (Commit 14): Tier C-partial — voice/tts.ts + voice/wake-word.ts

**Files:**
- `packages/gateway/src/voice/tts.ts` (41.76% → best-effort)
- `packages/gateway/src/voice/wake-word.ts` (51.18% → best-effort)

These are subprocess-bound and may not reach 80% in this PR — that's expected per spec §"Tier C — voice (likely partial)".

- [ ] **Step 1: Read both sources**

```bash
cat packages/gateway/src/voice/tts.ts
cat packages/gateway/src/voice/wake-word.ts
```

- [ ] **Step 2: Write cases against the platform branches you can stub**

For `tts.ts` — approximate 3 cases:
- Platform dispatch logic (which subprocess command per `process.platform`).
- `Bun.spawn` error → returns gracefully.
- Empty-string input → no-op.

For `wake-word.ts` — approximate 3 cases:
- Audio-device-not-available branch → `enabled = false`.
- Wake-word-match callback fires.
- Stop() clears the listener.

Mock `Bun.spawn` and any `child_process` calls with a thin stub.

- [ ] **Step 3: Measure coverage; raise watermarks if <80%**

```bash
bun test packages/gateway/src/voice/tts.test.ts \
         packages/gateway/src/voice/wake-word.test.ts
bun run audit:coverage-floor:build-lcov
grep -A 4 "voice/tts.ts" coverage/lcov.info | head -20
grep -A 4 "voice/wake-word.ts" coverage/lcov.info | head -20
```

If either file is still <80%, raise its `min_coverage_pct` in `docs/structure-audit/coverage-baseline.json` to the new measured value. Don't drop the entry.

- [ ] **Step 4: Lint + commit**

```bash
bun run lint:fix
git add packages/gateway/src/voice/
git commit -m "test(voice): partial coverage for tts + wake-word (Tier C-partial)

Phase 4 commit 14 of 16. ~6 new cases with mocked Bun.spawn covering
platform dispatch, spawn-error fallback, audio-device-miss, wake match,
and stop. Reaches 80% if subprocess mocking is tractable; otherwise
raises baseline watermarks (locked in per spec rule 3).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 15 (Commit 15): Tier D testable

**Files:**
- `packages/gateway/src/llm/registry.ts` (0% → ≥80%)
- `packages/gateway/src/config/session-toml.ts` (20.75% → ≥80%)
- `packages/gateway/src/platform/worker-security.ts` (0% → ≥80%)
- `packages/gateway/src/platform/gateway-state-file.ts` (0% → ≥80%)
- `packages/gateway/src/embedding/create-embedding-runtime.ts` (19.35% → ≥80%)
- `packages/gateway/src/embedding/model.ts` (13.51% → attempt ≥80% via `mock.module`)

- [ ] **Step 1: `llm/registry.ts` — write cases**

Use a mocked `LlmRouter` with stub providers + tmp-dir SQLite. Approximate 4 cases:
- `listAllModels` with all 3 provider ids registered, skipping unavailable.
- `setDefault` upserts into `llm_task_defaults` table.
- `pullModel` rejects when provider lacks `pullModel`.
- `getDefault` returns `undefined` with no DB.

- [ ] **Step 2: `config/session-toml.ts` — write cases**

Pure parser. Approximate 3 cases:
- Comment-only file → returns defaults.
- `[session]` block with `memory_ttl_hours = 12` → applied.
- Out-of-range value (e.g. 100000) → falls back to default.

- [ ] **Step 3: `platform/worker-security.ts` — write cases**

Approximate 3 cases:
- Empty origin (`""`) → `true`.
- `"null"` origin → `true`.
- Origin mismatch → `false` (with `globalThis.origin` stubbed via Object.defineProperty).

- [ ] **Step 4: `platform/gateway-state-file.ts` — write cases**

Tmp-dir fs. Approximate 3 cases:
- `writeGatewayStateFile` writes correct JSON shape.
- `logPath` env var fallback.
- `removeGatewayStateFile` silently no-ops when file is absent.

- [ ] **Step 5: `embedding/create-embedding-runtime.ts` — write cases**

Use `MockVault` + `processEnvGet` stub. Approximate 4 cases:
- `NIMBUS_SKIP_EMBEDDING_RUNTIME=1` → returns `null`.
- Disabled in TOML → returns `null`.
- OpenAI provider w/ vault key → returns lazy runtime.
- OpenAI provider w/o vault key → warns and returns `null`.

- [ ] **Step 6: `embedding/model.ts` — pure helper test + attempt full coverage**

`tensorToRowVectors` is pure and easy:
- 2 cases: 1×384 tensor + 2×384 batch.

For `createLocalEmbedder`, attempt `mock.module("@xenova/transformers", ...)` to stub the dynamic import. The mock must be installed before the function is called (use `beforeEach` + `mock.restore()` or similar). 2 cases:
- Mock returns a `pipeline` that yields a known tensor → `embed(["hi"])` returns the expected `Float32Array`.
- Empty input → returns `[]` (covers the `texts.length === 0` early return).

If the dynamic-import mock proves flaky, accept partial coverage and raise the baseline watermark.

- [ ] **Step 7: Run all 6 test files**

```bash
bun test packages/gateway/src/llm/registry.test.ts \
         packages/gateway/src/config/session-toml.test.ts \
         packages/gateway/src/platform/worker-security.test.ts \
         packages/gateway/src/platform/gateway-state-file.test.ts \
         packages/gateway/src/embedding/create-embedding-runtime.test.ts \
         packages/gateway/src/embedding/model.test.ts
```

Expected: green.

- [ ] **Step 8: Lint + commit**

```bash
bun run lint:fix
git add packages/gateway/src/
git commit -m "test(tier-d): cover llm/registry, session-toml, worker-security, gateway-state-file, create-embedding-runtime, embedding/model

Phase 4 commit 15 of 16. ~18 new cases bringing 6 Tier D files from
0-21% to >=80%. For embedding/model.ts, attempts full coverage via
mock.module(\"@xenova/transformers\", ...) on the dynamic import;
falls back to partial + raised watermark if the mock proves fragile.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 16 (Commit 16): Drop raised entries + plan + status row

**Files:**
- Modify: `docs/structure-audit/coverage-baseline.json` (drop raised entries; raise watermarks where partial)
- Add: `docs/superpowers/plans/2026-05-20-coverage-floor-phase-4.md` (this file)
- Add: `docs/superpowers/specs/2026-05-20-coverage-floor-phase-4-design.md` (the spec)
- Modify: `CLAUDE.md` + `GEMINI.md` (status row)

- [ ] **Step 1: Run the coverage build + update-baseline helper**

```bash
bun run audit:coverage-floor:build-lcov
bun run audit:coverage-floor:update-baseline
```

This regenerates `coverage-baseline.json` with:
- Files that crossed 80% → dropped.
- Files that improved but remain <80% → watermark raised.
- Files unchanged → unchanged.

- [ ] **Step 2: Diff the baseline file and sanity-check**

```bash
git diff docs/structure-audit/coverage-baseline.json | head -200
```

Confirm visually:
- ~33 entries dropped from gateway + cli + sdk near-floor (Tier A/B/C/D testable).
- Voice files (if <80%) have raised watermarks, not drops.
- Pinned files unchanged: `ipc/http-server.ts`, `ipc/server/server.ts`, `ipc/server/socket-listeners.ts`, `platform/paths.ts`, `platform/errors.ts`, `platform/index.ts`, `vault/factory.ts`, `cli/src/tui/App.tsx`.

If any pinned file's watermark shifted, do **not** revert blindly — investigate why (a real regression upstream is possible).

- [ ] **Step 3: Run the floor gate against the updated baseline**

```bash
bun run audit:coverage-floor
```

Expected: exit 0.

- [ ] **Step 4: Add the status row to CLAUDE.md + GEMINI.md**

Find the "Status:" paragraph in both files (under "**Status:** Phase 4 ✅ Complete · Phase 5…"). Append:

```
· Coverage floor Phase 4 ✅ (2026-05-20)
```

…in the same chronological position as the existing Phase 3A/3B-rest entries.

- [ ] **Step 5: Run the full PR-quality gate locally**

```bash
bun run typecheck
bun run lint
bun run audit:exclusion-parity
bun run audit:invariants
bun run audit:coverage-floor
bun run test:ci
```

All exit 0. If `test:ci` fails on a flaky test, re-run; if it fails reproducibly, fix before committing.

- [ ] **Step 6: Final commit**

```bash
git add docs/structure-audit/coverage-baseline.json \
        docs/superpowers/plans/2026-05-20-coverage-floor-phase-4.md \
        docs/superpowers/specs/2026-05-20-coverage-floor-phase-4-design.md \
        CLAUDE.md GEMINI.md
git commit -m "chore(coverage-floor): drop raised entries + Phase 4 plan

Phase 4 commit 16 of 16. Drops ~33 raised entries from
coverage-baseline.json (and raises voice watermarks if subprocess mocking
did not reach 80%). Adds the Phase 4 design spec + implementation plan.
Records the status row in CLAUDE.md + GEMINI.md.

Cumulative Phase 4 impact:
- 7 structural exclusions added (commit 1)
- ~33 baseline files raised to >=80% (commits 2-15)
- Baseline: 140 -> ~100 entries

The 3 Phase 2B-pinned IPC files (http-server, server, socket-listeners)
and 4 Windows-regression files (platform/{paths,errors,index}, vault/factory)
and 1 Phase 2B-pinned TUI file (cli/src/tui/App.tsx) remain at their
current watermarks per the explicit out-of-scope list in the spec.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 17: Push branch + open PR

- [ ] **Step 1: Push branch**

```bash
git push -u origin dev/asafgolombek/coverage-floor-phase-4-2026-05-21
```

- [ ] **Step 2: Open PR via `gh`**

```bash
gh pr create \
  --title "test(coverage-floor): Phase 4 — Long Tail (gateway + near-floor)" \
  --body "$(cat <<'EOF'
## Summary
- Raises ~33 gateway + near-floor CLI/SDK baseline entries above the 80% per-file coverage floor.
- Adds 7 structural exclusions for type-only and Bun Worker-entry files (`connectors/index.ts`, `embedding/embedding-{runtime,worker}.ts`, `db/query-guard-worker.ts`, `index/ranked-item.ts`, `vault/{nimbus-vault,ffi-ptr}.ts`).
- Drops baseline from 140 → ~100 entries.
- Voice files (`tts.ts`, `wake-word.ts`) land partial improvement + raised watermarks if subprocess mocking did not reach 80%.

Spec: `docs/superpowers/specs/2026-05-20-coverage-floor-phase-4-design.md`
Plan: `docs/superpowers/plans/2026-05-20-coverage-floor-phase-4.md`

## Test plan
- [ ] `bun run audit:coverage-floor:build-lcov && bun run audit:coverage-floor` exits 0
- [ ] `bun run audit:exclusion-parity` exits 0
- [ ] `bun run audit:invariants` exits 0
- [ ] `bun run lint` + `bun run typecheck` exit 0
- [ ] `bun run test:ci` green on CI Linux (authoritative)
- [ ] No file currently above 80% drops below 80%
- [ ] The 8 explicitly-out-of-scope files remain at their current baseline watermarks

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed; ready for review.

---

## Self-review checklist (run after writing this plan)

- [x] **Spec coverage:** Every section of the spec has a task — exclusions (Task 1), Tier A (Tasks 2+3), Tier B (Tasks 4–7 with mesh split), Tier C (Tasks 8–14 including voice partial), Tier D testable (Task 15), baseline drop + plan commit (Task 16), PR open (Task 17).
- [x] **Placeholder scan:** No "TBD" / "TODO" / "fill in details". Test cases described by behavior, not "write appropriate tests."
- [x] **Type consistency:** Function/method names referenced (`perServiceOAuthVaultKey`, `tryCreateEmbeddingWorkerBridge`, `tensorToRowVectors`, `writeGatewayStateFile`, `removeGatewayStateFile`, `isAcceptableWorkerOrigin`) match the source files read during brainstorming.
- [x] **Commit count:** 16 commits as promised in the spec (1 exclusions + 14 test commits + 1 baseline-drop = 16; Task 17 opens the PR, not a commit).
