# True Coverage C3 — StrykerJS mutation-testing harness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire a dev-only, advisory StrykerJS mutation-testing harness (never a CI gate), run it on the security core (`executor.ts` + `tool-output-envelope.ts`), and record the mutation score as the starting baseline.

**Architecture:** Pinned root devDependencies (`@stryker-mutator/core@9.6.1` + `@hughescr/stryker-bun-runner@1.2.2`) with the built-in `command` runner pre-wired as fallback. A `stryker.conf.json` scoped to the two security-core files (`thresholds.break: null` → never fails a build, `inPlace: true` → no monorepo sandbox), a `scripts/mutation/run-mutation.ts` wrapper for per-PR `--diff` scoping, and a contributor doc holding the baseline score. No CI/workflow change, no preflight-gate manifest entry, no coverage interaction.

**Tech Stack:** Bun 1.3.14 · TypeScript 6.x strict · StrykerJS 9.6.1 · `@hughescr/stryker-bun-runner` 1.2.2 · Node v24 (present, for the Stryker CLI).

**Spec:** [`docs/superpowers/specs/2026-06-13-true-coverage-C3-stryker-mutation-design.md`](../specs/2026-06-13-true-coverage-C3-stryker-mutation-design.md) (+ §10 review dispositions).

**Worktree:** `C:\gitrep\Nimbus\.claude\worktrees\tc-C3` · branch `dev/asafgolombek/true-coverage-C3` (off C2-merged main `7e806d17`). All paths repo-relative to that worktree.

**Verified during planning:** security-core test files are `engine/executor-delegation.test.ts`, `engine/executor-flagship.test.ts`, `engine/tool-output-envelope.test.ts`, `security-invariants.test.ts` (there is no `executor.test.ts`); `scripts` is in the root `test` glob so `scripts/mutation/run-mutation.test.ts` runs; pinned versions resolved via `npm view`.

---

## File structure

- **Create:** `stryker.conf.json` (repo root) — the harness config.
- **Create:** `scripts/mutation/run-mutation.ts` — the `--diff` per-PR scoping wrapper (exports a pure `filterMutableFiles` + a thin `main`).
- **Create:** `scripts/mutation/run-mutation.test.ts` — unit tests for `filterMutableFiles` + empty-diff behavior.
- **Create:** `docs/contributors/mutation-testing.md` — usage + baseline score + policy.
- **Modify:** root `package.json` — add `devDependencies` (pinned) + `mutation` / `mutation:diff` scripts.
- **Modify:** `.gitignore` — ignore `reports/` + `.stryker-tmp/`.

No source/test changes under `packages/*` (unless a surviving mutant reveals a real assertion gap — Task 3, fixed in-slice). No CI/workflow change. No `scripts/lib/preflight-gates.ts` entry.

---

## Task 1: Add pinned deps, author the config, smoke-test the runner

This is the risk-retiring task: it installs Stryker and proves *some* runner produces a mutation report on the security core.

**Files:**

- Modify: root `package.json` (devDependencies)
- Create: `stryker.conf.json`, `.gitignore` entries

- [ ] **Step 1: Dependency-safety pre-flight, then add the pinned deps (from repo root)**

Consult the `nimbus-commands` skill's dependency-safety pre-flight first. Then, from the worktree root (NOT inside a package):

```bash
cd C:/gitrep/Nimbus/.claude/worktrees/tc-C3
bun add -d --exact @stryker-mutator/core@9.6.1 @hughescr/stryker-bun-runner@1.2.2
```

Expected: both appear in root `package.json` `devDependencies` with exact versions (no `^`). Review the added transitive tree for anything alarming (these are dev-only test tooling).

- [ ] **Step 2: Read the bun-runner's config contract**

Run:

```bash
sed -n '1,120p' node_modules/@hughescr/stryker-bun-runner/README.md
ls node_modules/@stryker-mutator/core/schema/ 2>/dev/null
```

Expected: the README documents the `testRunner` name (expected `"bun"`), the plugin id `@hughescr/stryker-bun-runner`, and any `bun`-specific config block (e.g. how to scope which test files run). Note the exact keys — they parameterize Step 3.

- [ ] **Step 3: Write `stryker.conf.json`**

Create `stryker.conf.json` at the worktree root (adjust the `bun` block keys to match the README from Step 2 if they differ):

```json
{
  "$schema": "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
  "_comment": "Dev-only, advisory mutation harness (True Coverage C3). break:null => never fails a build. inPlace:true => mutate real files + restore (no monorepo sandbox). See docs/contributors/mutation-testing.md.",
  "testRunner": "bun",
  "plugins": ["@hughescr/stryker-bun-runner"],
  "coverageAnalysis": "perTest",
  "inPlace": true,
  "mutate": [
    "packages/gateway/src/engine/executor.ts",
    "packages/gateway/src/engine/tool-output-envelope.ts"
  ],
  "thresholds": { "high": 80, "low": 60, "break": null }
}
```

- [ ] **Step 4: Add `.gitignore` entries for Stryker artifacts**

Append to `.gitignore` (worktree root) if not already present:

```gitignore
# StrykerJS mutation testing (dev-only)
reports/
.stryker-tmp/
```

- [ ] **Step 5: Smoke-test the bun-runner**

Run:

```bash
cd C:/gitrep/Nimbus/.claude/worktrees/tc-C3
bunx stryker run 2>&1 | tail -40
```

Expected: Stryker instruments the two files, runs the relevant tests, and prints a **mutation score** table — and the process **exits 0 even if mutants survive** (because `break: null`).

**Decision branch:**

- If the bun-runner produces a report → keep `testRunner: "bun"`.
- If the bun-runner errors (plugin load, Bun-API mismatch, or sandbox/module-resolution failure even with `inPlace: true`) → switch to the **command-runner fallback**: replace `testRunner`/`plugins`/`coverageAnalysis` with:

  ```json
  "testRunner": "command",
  "coverageAnalysis": "off",
  "commandRunner": {
    "command": "bun test packages/gateway/src/engine/executor-delegation.test.ts packages/gateway/src/engine/executor-flagship.test.ts packages/gateway/src/engine/tool-output-envelope.test.ts packages/gateway/src/security-invariants.test.ts"
  }
  ```

  (Keep `inPlace`, `mutate`, `thresholds`.) Re-run `bunx stryker run` and confirm a report. The command runner reruns this **scoped** command per mutant — never a bare `bun test`.

- [ ] **Step 6: Confirm break:null is non-fatal**

Confirm from Step 5 output that the run exited 0 with surviving mutants present (advisory). Run `echo $?` immediately after a run if unsure:

```bash
bunx stryker run > /dev/null 2>&1; echo "exit=$?"
```

Expected: `exit=0` regardless of mutation score.

- [ ] **Step 7: Commit the harness config + deps**

```bash
cd C:/gitrep/Nimbus/.claude/worktrees/tc-C3
git add package.json bun.lock stryker.conf.json .gitignore
git commit -m "build(mutation): wire StrykerJS dev-only harness (advisory, break:null)

Pin @stryker-mutator/core@9.6.1 + @hughescr/stryker-bun-runner@1.2.2 (root
devDeps); stryker.conf.json scoped to the security core (executor.ts +
tool-output-envelope.ts), inPlace:true (no monorepo sandbox), break:null
(never fails a build). Command-runner fallback documented inline. Not a CI gate.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: The `run-mutation.ts` wrapper (TDD on the filter) + npm scripts

**Files:**

- Create: `scripts/mutation/run-mutation.ts`, `scripts/mutation/run-mutation.test.ts`
- Modify: root `package.json` (scripts)

- [ ] **Step 1: Write the failing test for the pure filter**

Create `scripts/mutation/run-mutation.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";

import { filterMutableFiles } from "./run-mutation.ts";

describe("filterMutableFiles", () => {
  test("keeps non-test gateway src .ts files", () => {
    expect(filterMutableFiles(["packages/gateway/src/engine/executor.ts"])).toEqual([
      "packages/gateway/src/engine/executor.ts",
    ]);
  });

  test("drops test/spec files", () => {
    expect(
      filterMutableFiles([
        "packages/gateway/src/engine/executor.ts",
        "packages/gateway/src/engine/executor.test.ts",
        "packages/gateway/src/engine/executor.spec.ts",
      ]),
    ).toEqual(["packages/gateway/src/engine/executor.ts"]);
  });

  test("drops non-gateway-src and non-ts paths", () => {
    expect(
      filterMutableFiles([
        "packages/cli/src/index.ts",
        "packages/gateway/test/unit/foo.ts",
        "docs/x.md",
        "packages/gateway/src/engine/executor.ts",
        "scripts/mutation/run-mutation.ts",
      ]),
    ).toEqual(["packages/gateway/src/engine/executor.ts"]);
  });

  test("normalizes Windows backslash paths", () => {
    expect(filterMutableFiles(["packages\\gateway\\src\\engine\\executor.ts"])).toEqual([
      "packages/gateway/src/engine/executor.ts",
    ]);
  });

  test("returns [] for an empty diff", () => {
    expect(filterMutableFiles([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd C:/gitrep/Nimbus/.claude/worktrees/tc-C3
bun test scripts/mutation/run-mutation.test.ts 2>&1 | tail -8
```

Expected: FAIL — `Cannot find module './run-mutation.ts'` / `filterMutableFiles is not exported`.

- [ ] **Step 3: Write `scripts/mutation/run-mutation.ts`**

Create `scripts/mutation/run-mutation.ts`:

```typescript
#!/usr/bin/env bun
import { spawnSync } from "node:child_process";

/**
 * From a list of changed paths, keep only the files Stryker may mutate:
 * non-test TypeScript under packages/gateway/src/. Paths are normalized to
 * forward slashes so the filter works on Windows `git diff` output too.
 */
export function filterMutableFiles(changed: readonly string[]): string[] {
  return changed
    .map((p) => p.replaceAll("\\", "/"))
    .filter(
      (p) =>
        p.startsWith("packages/gateway/src/") &&
        p.endsWith(".ts") &&
        !p.endsWith(".test.ts") &&
        !p.endsWith(".spec.ts"),
    );
}

/** First valid base ref among origin/main, main — else a helpful error. */
function resolveBaseRef(): string {
  for (const ref of ["origin/main", "main"]) {
    const r = spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], { encoding: "utf8" });
    if (r.status === 0) return ref;
  }
  throw new Error(
    "[mutation] Neither 'origin/main' nor 'main' is a valid git ref — run `git fetch origin main` first.",
  );
}

/** Changed gateway-src files vs the base ref (merge-base), filtered to mutable ones. */
function diffMutableFiles(): string[] {
  const baseRef = resolveBaseRef();
  const out = spawnSync("git", ["diff", "--name-only", `${baseRef}...HEAD`], {
    encoding: "utf8",
  });
  if (out.status !== 0) {
    const err = (out.stderr ?? "").trim();
    throw new Error(`git diff failed: ${err || `exit ${out.status}`}`);
  }
  const lines = out.stdout.split("\n").filter((l) => l.length > 0);
  return filterMutableFiles(lines);
}

function main(): void {
  const useDiff = process.argv.includes("--diff");
  let strykerArgs = ["stryker", "run"];

  if (useDiff) {
    const files = diffMutableFiles();
    if (files.length === 0) {
      console.log(
        "[mutation] No changed packages/gateway/src/*.ts files vs origin/main — nothing to mutate.",
      );
      return; // exit 0; never fall through to an unscoped whole-codebase run
    }
    console.log(`[mutation] Mutating ${files.length} changed file(s):\n  ${files.join("\n  ")}`);
    strykerArgs = ["stryker", "run", "--mutate", files.join(",")];
  }

  const res = spawnSync("bunx", strykerArgs, { stdio: "inherit" });
  process.exit(res.status ?? 1);
}

if (import.meta.main) {
  main();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
cd C:/gitrep/Nimbus/.claude/worktrees/tc-C3
bun test scripts/mutation/run-mutation.test.ts 2>&1 | tail -6
```

Expected: PASS (5 tests).

- [ ] **Step 5: Add the npm scripts**

In root `package.json`, add to `scripts` (next to other tooling scripts; keep JSON valid):

```json
"mutation": "stryker run",
"mutation:diff": "bun scripts/mutation/run-mutation.ts --diff"
```

- [ ] **Step 6: Manually verify the empty-diff path exits cleanly**

On the current branch (whose only changes are docs/config, no `packages/gateway/src/*.ts`):

```bash
cd C:/gitrep/Nimbus/.claude/worktrees/tc-C3
git fetch origin main --quiet
bun run mutation:diff 2>&1 | tail -3; echo "exit=$?"
```

Expected: prints `[mutation] No changed packages/gateway/src/*.ts files vs origin/main — nothing to mutate.` and `exit=0` (Stryker is NOT invoked).

- [ ] **Step 7: Typecheck + commit**

```bash
cd C:/gitrep/Nimbus/.claude/worktrees/tc-C3/packages/gateway && bun run typecheck 2>&1 | tail -4
cd C:/gitrep/Nimbus/.claude/worktrees/tc-C3
git add scripts/mutation/run-mutation.ts scripts/mutation/run-mutation.test.ts package.json
git commit -m "build(mutation): run-mutation.ts wrapper for per-PR --diff scoping

filterMutableFiles keeps non-test packages/gateway/src/*.ts (Windows-path safe);
--diff mutates only files changed vs origin/main; empty diff logs + exits 0
without invoking Stryker. Adds mutation / mutation:diff npm scripts.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

(Note: gateway `typecheck` does not cover `scripts/`; if `@nimbus-dev/client` false-fails, run `cd packages/client && bun run build` once. The scripts dir typechecks under the root `tsc` — Task 4 Step 2 runs the full typecheck.)

---

## Task 3: Run on the security core, record the baseline, write the doc

**Files:**

- Create: `docs/contributors/mutation-testing.md`
- (Possibly) Modify: a security-core test file, only if a surviving mutant is a real assertion gap.

- [ ] **Step 1: Run the harness on the security core and capture the score**

Run:

```bash
cd C:/gitrep/Nimbus/.claude/worktrees/tc-C3
bun run mutation 2>&1 | tee /tmp/mutation-baseline.txt | tail -40
```

Expected: a mutation-score table for `executor.ts` + `tool-output-envelope.ts`. Note the **overall mutation score %**, killed/survived/no-coverage counts, and any surviving mutants (file + line + mutator).

- [ ] **Step 2: Write the contributor doc**

Create `docs/contributors/mutation-testing.md` (fill `<…>` from Step 1's actual output):

```markdown
# Mutation testing (dev-only, advisory)

StrykerJS measures **assertion strength** — whether tests actually fail when the
code breaks — which line/branch coverage cannot. It is a **local developer tool**,
**not a CI gate** (`thresholds.break: null` → it never fails a build) and is not in
the preflight-gate manifest.

## Running it

- `bun run mutation` — mutate the configured security core (`engine/executor.ts`
  + `engine/tool-output-envelope.ts`).
- `bun run mutation:diff` — mutate only the `packages/gateway/src/*.ts` files
  changed vs `origin/main` (per-PR scope). An empty diff exits cleanly without
  running Stryker.

Config: `stryker.conf.json`. Runner: `@hughescr/stryker-bun-runner` (Bun), with
the built-in `command` runner as a documented fallback. `inPlace: true` mutates
real files and restores them (no monorepo sandbox); if a run is killed mid-restore,
`git restore` recovers.

## Baseline (2026-06-13)

Security core, first run:

| File | Mutation score | Killed | Survived | No coverage |
|---|---|---|---|---|
| engine/executor.ts | <X>% | <k> | <s> | <n> |
| engine/tool-output-envelope.ts | <X>% | <k> | <s> | <n> |

Surviving mutants of note: <list, or "none">.

## Roadmap

Advisory-first. Per-subsystem mutation-score baselines and flipping `break` to a
numeric floor are later decisions, once scores are stable across subsystems
(order: security core → engine/HITL → vault → query-gate → connector mappers).
```

- [ ] **Step 3: If a surviving mutant is a real assertion gap, strengthen the test**

Only if Step 1 surfaced a mutant on these 100%-covered files that represents a genuine missing assertion: add/strengthen the assertion in the relevant security-core test file, re-run `bun run mutation`, and update the doc's table. If all survivors are equivalent mutants (no behavioral change), note them as such in the doc and make no code change. (Do not weaken any invariant; executor.ts is I2–I4, envelope is I11.)

- [ ] **Step 4: Commit**

```bash
cd C:/gitrep/Nimbus/.claude/worktrees/tc-C3
git add docs/contributors/mutation-testing.md
# plus any security-core test file touched in Step 3
git commit -m "docs(mutation): record security-core mutation baseline + usage

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Validate, push, open PR

**Files:** none (validation + git).

- [ ] **Step 1: Confirm no CI gate / manifest drift was introduced**

Run:

```bash
cd C:/gitrep/Nimbus/.claude/worktrees/tc-C3
bun test scripts/preflight.test.ts 2>&1 | tail -6
```

Expected: PASS — the preflight-gate drift test is green (C3 added no CI gate, so the manifest is unchanged).

- [ ] **Step 2: Typecheck + Biome + markdownlint + the wrapper test**

Run:

```bash
cd C:/gitrep/Nimbus/.claude/worktrees/tc-C3
bun run typecheck 2>&1 | tail -6
bunx biome check scripts/mutation/run-mutation.ts scripts/mutation/run-mutation.test.ts 2>&1 | tail -4
bun run lint:markdown 2>&1 | tail -3
bun test scripts/mutation/run-mutation.test.ts 2>&1 | tail -4
```

Expected: typecheck clean (build `packages/client` first if `@nimbus-dev/client` false-fails); Biome `No fixes applied`; markdownlint `0 error(s)`; 5 wrapper tests pass. (`bun run lint` whole-repo Biome false-fails in a `.claude/worktree` — validate the changed files directly.)

- [ ] **Step 3: Push the branch**

```bash
cd C:/gitrep/Nimbus/.claude/worktrees/tc-C3
git push -u origin dev/asafgolombek/true-coverage-C3
```

- [ ] **Step 4: Open the PR**

```bash
gh pr create --base main --head dev/asafgolombek/true-coverage-C3 \
  --title "build(mutation): StrykerJS dev-only mutation harness + security-core baseline (True Coverage C3)" \
  --body "$(cat <<'BODY'
## What

Sub-project **C3** of the True Coverage program (depth) — a **dev-only, advisory** StrykerJS
mutation-testing harness. Never a CI gate, not in the preflight-gate manifest, no coverage
interaction.

## How

- Pinned root devDeps: `@stryker-mutator/core@9.6.1` + `@hughescr/stryker-bun-runner@1.2.2`, with the
  built-in `command` runner pre-wired as a fallback.
- `stryker.conf.json` scoped to the security core (`executor.ts` + `tool-output-envelope.ts`, both
  100% line+branch — surviving mutants = pure assertion-strength signals); `thresholds.break: null`
  (never fails a build); `inPlace: true` (no monorepo sandbox).
- `scripts/mutation/run-mutation.ts` (`bun run mutation` / `mutation:diff`) — per-PR `--diff`
  scoping; empty diff exits cleanly without an unscoped run. Pure filter is unit-tested.
- `docs/contributors/mutation-testing.md` records the security-core mutation baseline + policy.

## Tests / gating

No CI/workflow change; the preflight-gate drift test stays green. The wrapper's `filterMutableFiles`
has unit tests. Advisory-only — a numeric `break` floor is a later decision.

Spec: `docs/superpowers/specs/2026-06-13-true-coverage-C3-stryker-mutation-design.md`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

- [ ] **Step 5: Drive CI green**

Authoritative gate: **PR quality — TS/Bun (ubuntu-24.04) / Unit + Coverage**. The windows-2025
cross-platform leg is the chronic flake (rerun). Fix + resolve every CodeRabbit + Sonar thread.
Watch that the new root devDeps don't trip the JS-license-compliance or dependency-audit jobs (both
are dev-only, common test tooling — if flagged, add the standard allow per the existing pattern).

---

## Review dispositions (2026-06-13)

Addressing [the plan review](./2026-06-13-true-coverage-C3-stryker-mutation-review.md):

1. **§2.1 Git-ref robustness for `--diff` — ACCEPTED (refined).** `diffMutableFiles` now resolves
   the base ref via `resolveBaseRef()`, trying `origin/main` then local `main`, and throws a
   *helpful* error (`run git fetch origin main first`) if neither verifies — stronger than the naive
   two-level fallback because in a worktree both can be missing/stale. Code updated in Task 2 Step 3.
2. **§2.2 `inPlace` safety — ACKNOWLEDGED, no change.** The reviewer confirms the contributor doc
   already documents the `git restore` recovery for an aborted run (Task 3 Step 2). Left as-is.
3. **§2.3 Empty-diff unit test — ACKNOWLEDGED (validation), no change.** The `filterMutableFiles([])
   === []` test already covers the graceful-bypass condition (Task 2 Step 1).

## Self-review notes (author)

- **Spec coverage:** §3 pinned deps + command-runner fallback (Task 1) ✓ · §4 stryker.conf incl.
  inPlace/sandbox + scoped command-runner (Task 1 Steps 3/5) ✓ · §4 run-mutation.ts incl. empty-diff
  exit (Task 2) ✓ · §4 npm scripts (Task 2 Step 5) ✓ · §4 `.gitignore` (Task 1 Step 4) ✓ · §5 run +
  baseline doc (Task 3) ✓ · §6 no-CI/no-manifest (Task 4 Step 1) ✓ · §7 smoke test + break:null
  (Task 1 Steps 5/6) ✓ · §10 review dispositions (inPlace, empty-diff, scoped command) ✓.
- **Type consistency:** `filterMutableFiles(changed: readonly string[]): string[]` is defined in
  Task 2 Step 3 and imported in Task 2 Step 1's test; the command-runner command lists the exact
  verified test files; `mutation`/`mutation:diff` script names match between Task 2 and the doc.
- **No placeholders:** the only `<…>` are in the contributor doc table, deliberately filled from the
  Task 3 Step 1 run output (a measured value, not a plan gap).
- **Not pure TDD by nature:** Task 1 is a tooling/smoke-test decision task; Task 2's pure filter is
  true red→green; Task 3 is a measurement + doc (with an in-slice fix only if a real gap appears).
