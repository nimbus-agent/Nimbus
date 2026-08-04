# CI Feedback Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make local verification actually see what CI sees — fix the gate that is unrunnable in a worktree, typecheck the test directories that are currently invisible, add a Linux-parity runner, and stop a conflicted PR reading as green.

**Architecture:** Four independent changes sharing one principle — *a check that did no work is a failure, not a pass*. Nothing here invents a new gate list: `scripts/lib/preflight-gates.ts` already exists, is drift-guarded against the workflows, and is the single source both runners read. Commands are executed from the manifest's `cmd` arrays verbatim, never retyped.

**Tech Stack:** Bun 1.2+, TypeScript 6.x strict, Biome, markdownlint-cli2, Docker (`oven/bun:latest`), `gh` CLI.

## Global Constraints

- **No `any`** — use `unknown` for external data. TypeScript strict is non-negotiable.
- **Cross-platform:** `path.join()` / `os.tmpdir()`, never hardcoded separators. Baseline keys are normalized to forward slashes explicitly.
- **Do not modify** `packages/gateway/src/**` or any product code. This plan touches tooling, config, and test-scope only.
- **Never weaken an existing gate** to make something pass.
- Branch: `dev/asaf/ci-feedback-loop`. Never commit on `main`.
- Spec: [`../specs/2026-08-04-ci-feedback-loop-design.md`](../specs/2026-08-04-ci-feedback-loop-design.md).

## Running gates in this worktree (read before Task 1 lands)

Until Task 1 is merged, `bun run lint` reports **"0 files processed"** and exits 1 from inside `.claude/worktrees/**`. That is the bug being fixed, not your code. Until then verify biome with:

```bash
bunx biome check --vcs-enabled=false --error-on-warnings biome.json packages scripts
```

**A run reporting 0 files is never a pass.** Confirm a non-zero file count before believing an exit code. Never read an exit code through a pipe (`| tail` / `| grep`) — redirect to a file and check `$?` separately.

## File Structure

| File | Responsibility |
|---|---|
| `biome.json` | One-line ignore-pattern fix (Task 1) |
| `packages/cli/tsconfig.json` | Add `test/**/*` to `include` — zero debt (Task 2) |
| `packages/{gateway,ui}/tsconfig.tests.json` *(new)* | Same strictness as `src`, plus `test/**/*` (Task 4) |
| `scripts/typecheck-tests/parse.ts` *(new)* | Parse `tsc` output → `(file, code) → count`. Pure. |
| `scripts/typecheck-tests/baseline.ts` *(new)* | Baseline read/write/diff. Pure; sorted, normalized output. |
| `scripts/typecheck-tests/check.ts` *(new)* | CLI entry: run `tsc`, diff, report, `--update-baseline`. |
| `docs/structure-audit/typecheck-tests-baseline.json` *(new)* | Grandfathered debt |
| `scripts/lib/assert-work.ts` *(new)* | Shared "zero work is a failure" assertion (Task 5) |
| `scripts/ci/verify-in-docker.sh` *(new)* | Linux-parity manifest runner (Task 6) |
| `scripts/ci/verify-pr.ts` *(new)* | Post-push PR-state honesty check (Task 7) |
| `scripts/lib/preflight-gates.ts` | New gate entries (Tasks 2, 4, 5) |

---

### Task 1: Fix the biome ignore pattern

**Files:**

- Modify: `biome.json` (line ~12)

**Interfaces:**

- Consumes: nothing.
- Produces: a `bun run lint` that works from both the repo root and a linked worktree.

**Why this is first:** `preflight` fail-fasts, and `lint (biome)` is gate 2 of 23 in the fast tier. While it false-fails, every gate after it is unreachable, which is why the aggregate command gets abandoned and individual gates get missed.

- [ ] **Step 1: Reproduce the failure**

From inside this worktree:

```bash
bun run lint > /tmp/lint-before.log 2>&1; echo "EXIT=$?"; tail -6 /tmp/lint-before.log
```

Expected: `EXIT=1`, and output containing `No files were processed in the specified paths` / `These paths were provided but ignored: - .`

- [ ] **Step 2: Apply the one-line change**

In `biome.json`, inside `files.includes`:

```diff
-      "!**/.claude",
+      "!.claude",
```

**Do NOT add an explanatory comment to `biome.json`.** Put the rationale in the commit message instead.

This was tested, because a reviewer asserted biome parses JSONC here and that a comment would be fine. It is not fine, and it fails in the worst possible way:

| `biome.json` contents | `biome check .` result |
|---|---|
| `"!.claude"` alone | **3162 files checked** |
| `"!.claude"` + a `//` comment above it | **0 files checked, NO parse error** |

With a comment present biome reports `No files were processed` and prints its generic "check your biome.json or biome.jsonc" hint — it never says the comment is the problem. That is a silent config mis-parse, exactly the failure class this whole plan exists to remove, so introducing one here would be self-defeating.

(Biome does support comments in a file named `biome.jsonc`. Renaming the config is out of scope for this task and would touch every tool that references it by name.)

- [ ] **Step 3: Verify the worktree case is fixed**

```bash
bun run lint > /tmp/lint-after.log 2>&1; echo "EXIT=$?"; grep -E "Checked [0-9]+ files" /tmp/lint-after.log
```

Expected: `EXIT=0` and a **non-zero** file count (~3162). A "0 files" result means the fix did not work.

- [ ] **Step 4: Verify the repo root did NOT regress**

This is the load-bearing check. `!**/.claude` matched a `.claude` segment at any depth; `!.claude` is biome's folder-ignore form. Confirm the root still excludes all worktrees rather than descending into them:

```bash
cd C:/gitrep/Nimbus && bunx biome check --error-on-warnings . 2>&1 | grep -E "Checked [0-9]+ files"
```

Expected: **3155 files**, matching the pre-change count. A large jump (the repo has 22 worktrees) means the pattern is now descending into them — stop and report.

- [ ] **Step 5: Commit**

```bash
git add biome.json
git commit -F - <<'EOF'
fix(lint): anchor biome's .claude ignore so worktrees lint

"!**/.claude" matches a .claude segment at ANY depth, so a worktree at
.claude/worktrees/<branch>/ excluded itself: biome reported "0 files
processed" and exited 1, making `bun run lint` — and therefore
preflight and test:ci, which run it first — unusable from the directory
CLAUDE.md says to work in.

"!.claude" is biome's folder-ignore form (its own useBiomeIgnoreFolder
rule prefers it over "!.claude/**"). Measured both ways from the repo
root with 22 worktrees present: 3155 files either way, so the root still
excludes them. Inside a worktree: 0 -> 3162 files.
EOF
```

---

### Task 2: Typecheck `packages/cli/test/**` — no baseline needed

**Files:**

- Modify: `packages/cli/tsconfig.json`
- Modify: `scripts/lib/preflight-gates.ts` *(no change if the existing `typecheck` gate covers it — verify in Step 2)*

**Interfaces:**

- Consumes: nothing.
- Produces: `packages/cli/test/**` covered by the existing `bun run typecheck`.

**Context:** `packages/cli` runs `tsc --noEmit` against its own `tsconfig.json`, and the root `typecheck` script runs every package's. Measured: `packages/cli/test/**` currently produces **0 type errors**, so it can be gated outright — no baseline, no ratchet. Doing it first proves the approach on a clean package.

- [ ] **Step 1: Confirm the measurement still holds**

```bash
cd packages/cli && bunx tsc --noEmit -p tsconfig.json > /tmp/cli-before.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0`. Then verify test files are genuinely NOT covered yet:

```bash
grep -c "test/" /tmp/cli-before.log || echo "0 (test dir not in scope, as expected)"
```

- [ ] **Step 2: Add the test directory to `include`**

In `packages/cli/tsconfig.json`:

```diff
-  "include": ["src/**/*"],
+  "include": ["src/**/*", "test/**/*"],
```

Leave `exclude` untouched — it already excludes `**/*.test.tsx` / `**/*.spec.tsx`, which is unrelated to the `test/` directory.

- [ ] **Step 3: Run it and confirm still clean**

```bash
cd packages/cli && bunx tsc --noEmit -p tsconfig.json > /tmp/cli-after.log 2>&1; echo "EXIT=$?"; grep -cE "error TS" /tmp/cli-after.log
```

Expected: `EXIT=0`, error count 0. **If errors appear**, the measurement has gone stale — do not add a baseline for `cli` and do not relax anything. Stop and report the count and codes.

- [ ] **Step 4: Prove the gate now catches a real regression (red-prove)**

Temporarily break a call in a cli test file — e.g. remove a required argument from any function call in `packages/cli/test/`:

```bash
cd C:/gitrep/Nimbus/.claude/worktrees/ci-feedback-loop
bun run typecheck > /tmp/tc-red.log 2>&1; echo "EXIT=$?"; grep -E "error TS" /tmp/tc-red.log | head -3
```

Expected: non-zero exit naming your deliberate break. Then revert it and confirm `EXIT=0`. **Report what the failure said.** A gate nobody has watched fail is not yet a gate.

- [ ] **Step 5: Verify the root gate**

```bash
bun run typecheck > /tmp/tc-full.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0`.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/tsconfig.json
git commit -m "fix(cli): typecheck test/** — measured 0 pre-existing errors"
```

---

### Task 3: The baseline module (pure logic + tests)

**Files:**

- Create: `scripts/typecheck-tests/parse.ts`
- Create: `scripts/typecheck-tests/parse.test.ts`
- Create: `scripts/typecheck-tests/baseline.ts`
- Create: `scripts/typecheck-tests/baseline.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `type ErrorCounts = Map<string, Map<string, number>>` — `file → (TS code → count)`
  - `function parseTscOutput(raw: string): ErrorCounts`
  - `type Violation = { kind: "new_file" | "regression"; file: string; code: string; baseline: number; actual: number }`
  - `function evaluate(actual: ErrorCounts, baseline: ErrorCounts): Violation[]`
  - `function serializeBaseline(counts: ErrorCounts, generatedAt: string): string`
  - `function parseBaseline(raw: string): ErrorCounts`

Pure functions only — no `tsc` invocation, no file I/O. That keeps the tests fast and makes the diff logic testable on fixtures rather than by breaking real code.

- [ ] **Step 1: Write the failing parse test**

Create `scripts/typecheck-tests/parse.test.ts`:

```ts
// scripts/typecheck-tests/parse.test.ts
import { describe, expect, test } from "bun:test";
import { parseTscOutput } from "./parse.ts";

describe("parseTscOutput", () => {
  test("keys by (file, code) and counts occurrences", () => {
    const raw = [
      "packages/gateway/test/a.ts(12,3): error TS2554: Expected 5 arguments, but got 3.",
      "packages/gateway/test/a.ts(40,7): error TS2554: Expected 5 arguments, but got 3.",
      "packages/gateway/test/b.ts(9,1): error TS2532: Object is possibly 'undefined'.",
      "  Types of property 'x' are incompatible.", // continuation line — must be ignored
    ].join("\n");
    const out = parseTscOutput(raw);
    expect(out.get("packages/gateway/test/a.ts")?.get("TS2554")).toBe(2);
    expect(out.get("packages/gateway/test/b.ts")?.get("TS2532")).toBe(1);
    expect(out.size).toBe(2);
  });

  test("normalizes Windows separators to forward slashes", () => {
    const raw = String.raw`packages\gateway\test\a.ts(1,1): error TS2554: nope.`;
    const out = parseTscOutput(raw);
    expect([...out.keys()]).toEqual(["packages/gateway/test/a.ts"]);
  });

  test("ignores lines that are not error records", () => {
    expect(parseTscOutput("Found 3 errors.\n\n").size).toBe(0);
  });

  test("strips an absolute repo-root prefix so keys stay repo-relative", () => {
    const raw = "C:/gitrep/Nimbus/packages/gateway/test/a.ts(1,1): error TS2554: nope.";
    const out = parseTscOutput(raw, "C:/gitrep/Nimbus");
    expect([...out.keys()]).toEqual(["packages/gateway/test/a.ts"]);
  });

  test("leaves already-relative paths untouched when a root is supplied", () => {
    const raw = "packages/gateway/test/a.ts(1,1): error TS2554: nope.";
    const out = parseTscOutput(raw, "C:/gitrep/Nimbus");
    expect([...out.keys()]).toEqual(["packages/gateway/test/a.ts"]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun test scripts/typecheck-tests/parse.test.ts
```

Expected: FAIL — `Cannot find module './parse.ts'`

- [ ] **Step 3: Implement `parse.ts`**

```ts
// scripts/typecheck-tests/parse.ts

/** `file (POSIX-relative) -> (TS error code -> count)`. */
export type ErrorCounts = Map<string, Map<string, number>>;

/**
 * One `tsc --noEmit` diagnostic line looks like:
 *   packages/gateway/test/a.ts(12,3): error TS2554: Expected 5 arguments, but got 3.
 * Continuation lines (indented explanations) carry no `(line,col): error TSxxxx:` and are skipped.
 */
const LINE_RE = /^(.+?)\((\d+),(\d+)\): error (TS\d+):/;

/**
 * Paths are normalized to forward slashes regardless of host OS. `tsc` already emits forward
 * slashes on Windows in practice, but the baseline is generated on a developer machine and
 * validated inside a Linux container — a separator mismatch there would fail every key at once.
 */
export function parseTscOutput(raw: string, repoRoot?: string): ErrorCounts {
  const rootPrefix =
    repoRoot === undefined ? undefined : `${repoRoot.replaceAll("\\", "/").replace(/\/+$/, "")}/`;
  const out: ErrorCounts = new Map();
  for (const line of raw.split("\n")) {
    const m = LINE_RE.exec(line);
    if (m === null) continue;
    let file = (m[1] ?? "").replaceAll("\\", "/").trim();
    // Strip an absolute prefix if tsc emitted one. Keys MUST be repo-relative: the baseline is
    // generated on a developer machine (C:/gitrep/Nimbus/...) and validated inside a container
    // (/src/...). An absolute key would mismatch every entry at once and read as total regression.
    if (rootPrefix !== undefined && file.startsWith(rootPrefix)) file = file.slice(rootPrefix.length);
    const code = m[4] ?? "";
    if (file === "" || code === "") continue;
    let byCode = out.get(file);
    if (byCode === undefined) {
      byCode = new Map();
      out.set(file, byCode);
    }
    byCode.set(code, (byCode.get(code) ?? 0) + 1);
  }
  return out;
}
```

- [ ] **Step 4: Confirm parse tests pass**

```bash
bun test scripts/typecheck-tests/parse.test.ts
```

Expected: PASS (3 tests)

- [ ] **Step 5: Write the failing baseline test**

Create `scripts/typecheck-tests/baseline.test.ts`:

```ts
// scripts/typecheck-tests/baseline.test.ts
import { describe, expect, test } from "bun:test";
import { evaluate, parseBaseline, serializeBaseline } from "./baseline.ts";
import type { ErrorCounts } from "./parse.ts";

function counts(o: Record<string, Record<string, number>>): ErrorCounts {
  return new Map(Object.entries(o).map(([f, c]) => [f, new Map(Object.entries(c))]));
}

describe("evaluate", () => {
  test("unchanged counts produce no violations", () => {
    const c = counts({ "a.ts": { TS1: 2 } });
    expect(evaluate(c, counts({ "a.ts": { TS1: 2 } }))).toEqual([]);
  });

  test("a higher count for a known (file, code) is a regression", () => {
    const v = evaluate(counts({ "a.ts": { TS1: 3 } }), counts({ "a.ts": { TS1: 2 } }));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ kind: "regression", file: "a.ts", code: "TS1", baseline: 2, actual: 3 });
  });

  test("a NEW code in a known file fails (this is the #1038 case)", () => {
    const v = evaluate(counts({ "a.ts": { TS1: 2, TS2554: 5 } }), counts({ "a.ts": { TS1: 2 } }));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ kind: "regression", code: "TS2554", baseline: 0, actual: 5 });
  });

  test("a file absent from the baseline fails", () => {
    const v = evaluate(counts({ "new.ts": { TS1: 1 } }), counts({}));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ kind: "new_file", file: "new.ts" });
  });

  test("a LOWER count is not a violation (debt may be paid down)", () => {
    expect(evaluate(counts({ "a.ts": { TS1: 1 } }), counts({ "a.ts": { TS1: 2 } }))).toEqual([]);
  });
});

describe("serializeBaseline", () => {
  test("writes keys sorted, so diffs stay reviewable", () => {
    const json = serializeBaseline(counts({ "b.ts": { TS2: 1 }, "a.ts": { TS9: 1, TS1: 1 } }), "T");
    expect(json.indexOf('"a.ts"')).toBeLessThan(json.indexOf('"b.ts"'));
    expect(json.indexOf('"TS1"')).toBeLessThan(json.indexOf('"TS9"'));
  });

  test("round-trips through parseBaseline", () => {
    const c = counts({ "a.ts": { TS1: 2 }, "b.ts": { TS3: 1 } });
    expect(parseBaseline(serializeBaseline(c, "T"))).toEqual(c);
  });
});
```

- [ ] **Step 6: Run it and watch it fail**

```bash
bun test scripts/typecheck-tests/baseline.test.ts
```

Expected: FAIL — `Cannot find module './baseline.ts'`

- [ ] **Step 7: Implement `baseline.ts`**

```ts
// scripts/typecheck-tests/baseline.ts
import type { ErrorCounts } from "./parse.ts";

export type Violation =
  | { readonly kind: "new_file"; readonly file: string; readonly code: string; readonly baseline: 0; readonly actual: number }
  | { readonly kind: "regression"; readonly file: string; readonly code: string; readonly baseline: number; readonly actual: number };

/**
 * A single rule covers both cases: any `(file, code)` whose count EXCEEDS its baseline (absent = 0)
 * is a violation. `kind` only changes the message — a file the baseline has never seen is reported
 * as `new_file` because that reads more clearly than "regressed from 0".
 *
 * KNOWN LIMITATION: fixing one TS2554 while adding another in the same file nets zero and passes.
 * This is the same per-file granularity trade-off `coverage-floor` already makes; a finer key
 * (line numbers) is not stable enough to gate on.
 */
export function evaluate(actual: ErrorCounts, baseline: ErrorCounts): Violation[] {
  const out: Violation[] = [];
  for (const [file, byCode] of actual) {
    const baseFile = baseline.get(file);
    for (const [code, count] of byCode) {
      const baseCount = baseFile?.get(code) ?? 0;
      if (count <= baseCount) continue;
      out.push(
        baseFile === undefined
          ? { kind: "new_file", file, code, baseline: 0, actual: count }
          : { kind: "regression", file, code, baseline: baseCount, actual: count },
      );
    }
  }
  return out;
}

interface BaselineFile {
  readonly version: 1;
  readonly generated_at: string;
  readonly files: Record<string, Record<string, number>>;
}

/** Sorted on both axes so an update produces a reviewable diff, mirroring coverage-floor. */
export function serializeBaseline(counts: ErrorCounts, generatedAt: string): string {
  const files: Record<string, Record<string, number>> = {};
  for (const file of [...counts.keys()].sort()) {
    const byCode = counts.get(file);
    if (byCode === undefined) continue;
    const codes: Record<string, number> = {};
    for (const code of [...byCode.keys()].sort()) codes[code] = byCode.get(code) ?? 0;
    files[file] = codes;
  }
  const doc: BaselineFile = { version: 1, generated_at: generatedAt, files };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export function parseBaseline(raw: string): ErrorCounts {
  const doc = JSON.parse(raw) as unknown;
  if (typeof doc !== "object" || doc === null) throw new Error("baseline: not an object");
  const files = (doc as { files?: unknown }).files;
  if (typeof files !== "object" || files === null) throw new Error("baseline: missing `files`");
  const out: ErrorCounts = new Map();
  for (const [file, codes] of Object.entries(files as Record<string, unknown>)) {
    if (typeof codes !== "object" || codes === null) continue;
    const m = new Map<string, number>();
    for (const [code, n] of Object.entries(codes as Record<string, unknown>)) {
      if (typeof n === "number") m.set(code, n);
    }
    out.set(file, m);
  }
  return out;
}
```

- [ ] **Step 8: Confirm all tests pass**

```bash
bun test scripts/typecheck-tests/
```

Expected: PASS (10 tests)

- [ ] **Step 9: Commit**

```bash
git add scripts/typecheck-tests/
git commit -m "feat(tooling): typecheck-tests baseline parse + diff (pure logic)"
```

---

### Task 4: Wire `typecheck:tests` for gateway and ui

**Files:**

- Create: `packages/gateway/tsconfig.tests.json`
- Create: `packages/ui/tsconfig.tests.json`
- Create: `scripts/typecheck-tests/check.ts`
- Create: `docs/structure-audit/typecheck-tests-baseline.json`
- Modify: `package.json` (two scripts)
- Modify: `scripts/lib/preflight-gates.ts` (one gate)

**Interfaces:**

- Consumes: `parseTscOutput`, `evaluate`, `serializeBaseline`, `parseBaseline` (Task 3).
- Produces: `bun run typecheck:tests` and `bun run typecheck:tests:update-baseline`.

**Expected debt** (measured): `gateway` 404 errors / 100 files, `ui` 68 / 14. `cli` is excluded — Task 2 gates it outright.

- [ ] **Step 1: Create the two tsconfigs**

`packages/gateway/tsconfig.tests.json`:

```json
{
  "extends": "./tsconfig.json",
  "include": ["src/**/*", "test/**/*"]
}
```

`packages/ui/tsconfig.tests.json`:

```json
{
  "extends": "./tsconfig.json",
  "include": ["src/**/*", "test/**/*", "vite.config.ts", "vitest.config.ts"]
}
```

Note `ui`'s base already sets `noPropertyAccessFromIndexSignature: false`; inherit it rather than restating. Do NOT relax any other strictness — the spec rejected a second strictness regime.

- [ ] **Step 2: Implement `check.ts`**

```ts
// scripts/typecheck-tests/check.ts
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { evaluate, parseBaseline, serializeBaseline } from "./baseline.ts";
import { type ErrorCounts, parseTscOutput } from "./parse.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const BASELINE = resolve(REPO_ROOT, "docs", "structure-audit", "typecheck-tests-baseline.json");
const PROJECTS = ["packages/gateway/tsconfig.tests.json", "packages/ui/tsconfig.tests.json"] as const;

async function collect(): Promise<ErrorCounts> {
  const merged: ErrorCounts = new Map();
  for (const project of PROJECTS) {
    const p = Bun.spawnSync(["bunx", "tsc", "--noEmit", "-p", project], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const raw = `${p.stdout.toString()}\n${p.stderr.toString()}`;
    // Pass REPO_ROOT so an absolute path from tsc is reduced to a repo-relative key.
    for (const [file, byCode] of parseTscOutput(raw, REPO_ROOT)) {
      const target = merged.get(file) ?? new Map<string, number>();
      for (const [code, n] of byCode) target.set(code, (target.get(code) ?? 0) + n);
      merged.set(file, target);
    }
  }
  return merged;
}

async function main(): Promise<void> {
  const update = process.argv.slice(2).includes("--update-baseline");
  const actual = await collect();

  if (update) {
    await Bun.write(BASELINE, serializeBaseline(actual, new Date().toISOString()));
    const files = actual.size;
    const errors = [...actual.values()].reduce((a, m) => a + [...m.values()].reduce((x, y) => x + y, 0), 0);
    console.log(`typecheck-tests: baseline updated (${String(errors)} errors across ${String(files)} files)`);
    return;
  }

  if (!existsSync(BASELINE)) {
    console.error("typecheck-tests: baseline missing — run `bun run typecheck:tests:update-baseline`");
    process.exit(2);
  }
  const baseline = parseBaseline(await Bun.file(BASELINE).text());
  const violations = evaluate(actual, baseline);

  if (violations.length > 0) {
    for (const v of violations) {
      console.error(
        v.kind === "new_file"
          ? `::error file=${v.file}::typecheck-tests: NEW file with errors — ${v.code} ×${String(v.actual)}`
          : `::error file=${v.file}::typecheck-tests: ${v.code} regressed ${String(v.baseline)} -> ${String(v.actual)}`,
      );
    }
    console.error(`typecheck-tests: ${String(violations.length)} violation(s)`);
    process.exit(1);
  }

  const known = [...baseline.values()].reduce((a, m) => a + [...m.values()].reduce((x, y) => x + y, 0), 0);
  console.log(`typecheck-tests: ok (${String(known)} known errors baselined, 0 new)`);
}

await main();
```

- [ ] **Step 3: Add the scripts**

In root `package.json`:

```json
"typecheck:tests": "bun scripts/typecheck-tests/check.ts",
"typecheck:tests:update-baseline": "bun scripts/typecheck-tests/check.ts --update-baseline",
```

- [ ] **Step 4: Generate the baseline**

```bash
bun run typecheck:tests:update-baseline
```

Expected: roughly **472 errors across 114 files** (gateway 404/100 + ui 68/14). If the number is wildly different, stop and report — the tsconfigs may be pulling in more than intended.

- [ ] **Step 5: Confirm the gate is green against its own baseline**

```bash
bun run typecheck:tests > /tmp/tt.log 2>&1; echo "EXIT=$?"; cat /tmp/tt.log
```

Expected: `EXIT=0`, `typecheck-tests: ok (… known errors baselined, 0 new)`

- [ ] **Step 6: RED-PROVE by reproducing #1038**

This is the reason the task exists. In `packages/gateway/test/e2e/scenarios/hitl-write-ops.test.ts`, remove the last argument from the `new ToolExecutor(...)` call:

```bash
bun run typecheck:tests > /tmp/tt-red.log 2>&1; echo "EXIT=$?"; grep "TS2554" /tmp/tt-red.log | head -2
```

Expected: `EXIT=1` and a `TS2554` violation naming that file. **Restore the argument**, re-run, confirm `EXIT=0`. Report exactly what the failure line said — this is the evidence the gate works.

- [ ] **Step 7: Register the gate in the manifest**

In `scripts/lib/preflight-gates.ts`, add to the `FAST` array, immediately after the `typecheck` entry:

```ts
  {
    // Test directories are NOT in any package's tsconfig `include`, so `typecheck` is blind to
    // them: in #1038 five ToolExecutor call sites broke and `bun run typecheck` still exited 0.
    // Gated against a committed baseline of pre-existing debt; only NEW errors fail.
    name: "typecheck:tests",
    cmd: ["bun", "run", "typecheck:tests"],
    tier: "fast",
  },
```

- [ ] **Step 8: Verify the manifest drift guard still passes**

```bash
bun test scripts/lib/preflight-gates.test.ts scripts/preflight.test.ts > /tmp/drift.log 2>&1; echo "EXIT=$?"; tail -3 /tmp/drift.log
```

Expected: `EXIT=0`. The new gate is local-only, so it does not need a `CI_ONLY_GATES` entry — but if the drift guard complains, read its message rather than adding one reflexively.

- [ ] **Step 9: Commit**

```bash
git add packages/gateway/tsconfig.tests.json packages/ui/tsconfig.tests.json scripts/typecheck-tests/check.ts docs/structure-audit/typecheck-tests-baseline.json package.json scripts/lib/preflight-gates.ts
git commit -F - <<'EOF'
feat(tooling): gate typecheck over gateway+ui test/** with a baseline ratchet

No package tsconfig includes its test/ directory, so `bun run typecheck`
exits 0 while those trees are entirely unread. In #1038 that let five
ToolExecutor call sites pass 3 args to a 5-arg constructor all the way
into CI.

Gated at the same strictness as src against a committed baseline of the
pre-existing debt (gateway 404, ui 68). Only NEW (file, code) counts
fail. cli needs no baseline — it already typechecks clean.
EOF
```

---

### Task 5: "Zero work is a failure"

**Files:**

- Create: `scripts/lib/assert-work.ts`
- Create: `scripts/lib/assert-work.test.ts`
- Modify: `package.json` (`lint`, `lint:markdown`)

**Interfaces:**

- Consumes: nothing.
- Produces: `function assertDidWork(output: string, patterns: readonly RegExp[], label: string): void`

**Scope:** applied ONLY to `lint` and `lint:markdown` — the two gates that demonstrably report zero work. The spec deferred a general per-gate mechanism; do not add fields to the `Gate` interface.

- [ ] **Step 1: Write the failing test**

```ts
// scripts/lib/assert-work.test.ts
import { describe, expect, test } from "bun:test";
import { assertDidWork } from "./assert-work.ts";

const BIOME = [/Checked (\d+) files/];

describe("assertDidWork", () => {
  test("passes when the tool reports a non-zero count", () => {
    expect(() => assertDidWork("Checked 3162 files in 700ms.", BIOME, "lint")).not.toThrow();
  });

  test("THROWS when the tool reports zero — a check that did nothing is not a pass", () => {
    expect(() => assertDidWork("Checked 0 files in 12ms.", BIOME, "lint")).toThrow(/did no work/i);
  });

  test("throws when no count can be found at all", () => {
    expect(() => assertDidWork("something unexpected", BIOME, "lint")).toThrow(/could not confirm/i);
  });
});
```

- [ ] **Step 2: Run it, watch it fail**

```bash
bun test scripts/lib/assert-work.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// scripts/lib/assert-work.ts

/**
 * A gate that ran but processed nothing is a FAILURE, not a pass.
 *
 * Three separate incidents in PR #1038 trace to a tool that ran, did nothing, and said so quietly —
 * most damagingly biome reporting "0 files processed" from inside a worktree, which made the whole
 * preflight aggregate look broken and got it skipped.
 *
 * Deliberately narrow: applied to the two gates that can actually report zero work. A per-gate
 * regex on every manifest entry was considered and rejected — a regex over tool output is itself a
 * silent-failure surface when a tool changes its wording on upgrade.
 */
export function assertDidWork(output: string, patterns: readonly RegExp[], label: string): void {
  for (const re of patterns) {
    const m = re.exec(output);
    if (m === null) continue;
    const n = Number.parseInt(m[1] ?? "", 10);
    if (Number.isNaN(n)) continue;
    if (n > 0) return;
    throw new Error(`${label}: did no work (${String(n)} units processed) — this is a failure, not a pass`);
  }
  throw new Error(`${label}: could not confirm any work was done (no unit count found in output)`);
}
```

- [ ] **Step 4: Confirm tests pass**

```bash
bun test scripts/lib/assert-work.test.ts
```

Expected: PASS (3 tests)

- [ ] **Step 5: Wrap the two gates**

Create `scripts/lib/run-gate-with-work-check.ts`:

```ts
// scripts/lib/run-gate-with-work-check.ts
import { assertDidWork } from "./assert-work.ts";

const PATTERNS: Record<string, RegExp[]> = {
  lint: [/Checked (\d+) files/],
  "lint:markdown": [/Linting: (\d+) files/],
};

const label = process.argv[2] ?? "";
const cmd = process.argv.slice(3);
if (label === "" || cmd.length === 0) {
  console.error("usage: run-gate-with-work-check <label> <cmd...>");
  process.exit(2);
}

const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
const out = `${p.stdout.toString()}${p.stderr.toString()}`;
process.stdout.write(out);

if (p.exitCode !== 0) process.exit(p.exitCode ?? 1);

try {
  assertDidWork(out, PATTERNS[label] ?? [], label);
} catch (err) {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
}
```

Then in `package.json`:

```json
"lint": "bun scripts/lib/run-gate-with-work-check.ts lint biome check --error-on-warnings .",
"lint:markdown": "bun scripts/lib/run-gate-with-work-check.ts lint:markdown markdownlint-cli2",
```

**Preserve the underlying commands exactly** — `--error-on-warnings` is load-bearing (its absence hid a config-schema error in #1038).

- [ ] **Step 6: Verify both gates still pass and still do work**

```bash
bun run lint > /tmp/l.log 2>&1; echo "lint=$?"; grep -E "Checked [0-9]+ files" /tmp/l.log
bun run lint:markdown > /tmp/m.log 2>&1; echo "markdown=$?"; grep -E "Linting: [0-9]+ files" /tmp/m.log
```

Expected: both `=0`, both showing non-zero counts.

- [ ] **Step 7: RED-PROVE the assertion fires**

Temporarily point biome at a path that matches nothing (e.g. `bun scripts/lib/run-gate-with-work-check.ts lint biome check --error-on-warnings ./nonexistent-dir`) and confirm it exits non-zero with the "did no work" message. Report what it said, then revert.

- [ ] **Step 8: Commit**

```bash
git add scripts/lib/assert-work.ts scripts/lib/assert-work.test.ts scripts/lib/run-gate-with-work-check.ts package.json
git commit -m "feat(tooling): fail gates that process zero units of work"
```

---

### Task 6: `verify-in-docker.sh` — Linux parity

**Files:**

- Create: `scripts/ci/verify-in-docker.sh`
- Modify: `package.json` (one script)

**Interfaces:**

- Consumes: `PREFLIGHT_GATES`, `CI_ONLY_GATES` from `scripts/lib/preflight-gates.ts`.
- Produces: `bun run verify:docker [--full]`

**Model it on `scripts/coverage-floor/reseed-docker.sh`** — read that file first. It already solves every environmental problem here and documents why: `MSYS_NO_PATHCONV` for Git Bash, tar-stream instead of bind-mount (a bind mount produced garbage results), a named cache volume, and the apt packages CI has (`git libsecret-tools gnome-keyring dbus`) without which vault/PAL tests fail and falsely un-cover whole subsystems.

**Deviate from it in one respect: bake the apt layer into a cached image.** `reseed-docker.sh` runs `apt-get install` inside `docker run --rm`, so the work is discarded every invocation. **Measured: 49.5 seconds, every run.** That is acceptable for a coverage reseed you run occasionally; it is not acceptable for a loop meant to be routine, and a 50-second tax is exactly what makes a tool get skipped — which is the root cause this plan exists to fix.

Build a tiny local image once and reuse it. First run pays ~50s; subsequent runs pay nothing.

- [ ] **Step 1: Write the runner**

```bash
#!/usr/bin/env bash
# verify-in-docker.sh — run the PREFLIGHT_GATES manifest inside a Linux container at a NORMAL path.
#
# Why: local gates can be blind to what CI sees. Two classes cause it — path exclusions (a worktree
# under .claude/ excluded itself from biome) and OS differences (audit:coverage-floor is
# CI-Linux-authoritative). Running the manifest at /src in oven/bun removes both at once.
#
# Gate commands come from the manifest's `cmd` arrays VERBATIM. Nothing is retyped here: in #1038
# `audit:any` was run without its `--check` flag and silently exited 0.
set -euo pipefail
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BASE_IMAGE="oven/bun:latest"     # matches CI (bun 1.3.x)
IMAGE="nimbus-verify:local"      # BASE_IMAGE + the apt layer, built once
CACHE_VOL="nimbus-bun-cache"
TIER="fast"
[[ "${1:-}" == "--full" ]] && TIER="full"
[[ "${1:-}" == "--rebuild" ]] && docker image rm -f "${IMAGE}" >/dev/null 2>&1 || true

cd "${REPO_ROOT}"
docker volume create "${CACHE_VOL}" >/dev/null

# Build the apt layer ONCE. Running apt inside `docker run --rm` discards it every invocation —
# measured at 49.5s per run, which is precisely the kind of tax that makes a tool get skipped.
if ! docker image inspect "${IMAGE}" >/dev/null 2>&1; then
  echo "--- building ${IMAGE} (one-time, ~1 min) ---"
  docker build -t "${IMAGE}" -f - . <<DOCKERFILE
FROM ${BASE_IMAGE}
ENV DEBIAN_FRONTEND=noninteractive
# Same packages CI's ubuntu runner has. Without libsecret/gnome-keyring/dbus the vault and PAL
# tests fail, which falsely un-covers every subsystem they exercise.
RUN apt-get update -qq \\
 && apt-get install -y -qq git libsecret-tools gnome-keyring dbus \\
 && rm -rf /var/lib/apt/lists/*
DOCKERFILE
fi

echo "--- docker: running ${TIER}-tier manifest gates (${IMAGE}) ---"
tar --exclude=node_modules --exclude=.git --exclude=./coverage --exclude=dist \
    --exclude=.claude -c -C "${REPO_ROOT}" . \
  | docker run --rm -i \
      -e CI=true -e TIER="${TIER}" \
      -v "${CACHE_VOL}:/root/.bun/install/cache" \
      -w /src \
      "${IMAGE}" \
      bash -c '
        set -euo pipefail
        mkdir -p /src && tar -x -C /src
        bun install --frozen-lockfile
        bun scripts/ci/run-manifest-gates.ts "$TIER"
      '
```

`--rebuild` forces the image to be rebuilt when the base image or package set changes. Document it in the script header; a stale cached image silently pinning an old bun version is the obvious failure mode of this optimisation, and `--rebuild` is the escape hatch.

- [ ] **Step 2: Write the in-container gate runner**

Create `scripts/ci/run-manifest-gates.ts`:

```ts
// scripts/ci/run-manifest-gates.ts
import { CI_ONLY_GATES, selectGates } from "../lib/preflight-gates.ts";

const tier = process.argv[2] === "full" ? "full" : "fast";
const skip = new Set(CI_ONLY_GATES);
const failures: string[] = [];
const skipped: string[] = [];

/**
 * Gate ids are NOT uniformly at cmd[2]. The manifest holds both shapes:
 *   ["bun", "run", "audit:any", "--check"]  -> id is cmd[2]
 *   ["bunx", "jscpd", "packages"]           -> id is cmd[1]
 * Reading cmd[2] blindly would yield "packages" for the jscpd gate, so a `bunx` gate could never
 * be matched against CI_ONLY_GATES — and a gate whose third argument happened to collide with a
 * CI_ONLY name would be wrongly skipped, silently reducing coverage.
 */
function gateId(cmd: readonly string[]): string {
  if (cmd[0] === "bunx") return cmd[1] ?? "";
  return cmd[2] ?? "";
}

for (const gate of selectGates(tier)) {
  const id = gateId(gate.cmd) || gate.name;
  if (skip.has(id)) {
    skipped.push(gate.name);
    continue;
  }
  const p = Bun.spawnSync(gate.cmd, { stdout: "inherit", stderr: "inherit" });
  const ok = p.exitCode === 0;
  console.log(`${ok ? "ok  " : "FAIL"}  ${gate.name}`);
  if (!ok) failures.push(gate.name);
}

if (skipped.length > 0) console.log(`\nskipped (CI_ONLY_GATES): ${skipped.join(", ")}`);
console.log(failures.length === 0 ? "\nALL GATES PASS" : `\nFAILED: ${failures.join(" | ")}`);
process.exit(failures.length === 0 ? 0 : 1);
```

Skipped gates are **printed**, never silent — a summary that hides what it did not run implies coverage it does not have.

- [ ] **Step 3: Add the script + make executable**

```json
"verify:docker": "bash scripts/ci/verify-in-docker.sh",
```

```bash
chmod +x scripts/ci/verify-in-docker.sh
```

- [ ] **Step 4: Run it**

```bash
bun run verify:docker > /tmp/vd.log 2>&1; echo "EXIT=$?"; tail -20 /tmp/vd.log
```

Expected: `EXIT=0` and a per-gate table ending `ALL GATES PASS`. First run is slow (apt + install); later runs reuse the cache volume.

- [ ] **Step 5: RED-PROVE — a failing gate must fail the run**

Temporarily add a bogus gate to the `FAST` array (e.g. `cmd: ["bun", "run", "definitely-not-a-script"]`), re-run, confirm non-zero exit and that the gate is listed under `FAILED:`. Remove it and re-confirm green. Report what it printed.

- [ ] **Step 6: Commit**

```bash
git add scripts/ci/verify-in-docker.sh scripts/ci/run-manifest-gates.ts package.json
git commit -m "feat(tooling): run manifest gates in a Linux container at a normal path"
```

---

### Task 7: `verify:pr` — post-push honesty check

**Files:**

- Create: `scripts/ci/verify-pr.ts`
- Create: `scripts/ci/verify-pr.test.ts`
- Modify: `package.json` (one script)

**Interfaces:**

- Consumes: `gh` CLI.
- Produces: `bun run verify:pr [<pr-number>]`, and a pure `evaluatePrState(input): PrVerdict` for testing.

**Not a manifest gate** — it needs network and `gh` auth, exactly the properties `CI_ONLY_GATES` documents as disqualifying. Do not add it to `PREFLIGHT_GATES`.

- [ ] **Step 1: Write the failing test**

```ts
// scripts/ci/verify-pr.test.ts
import { describe, expect, test } from "bun:test";
import { evaluatePrState } from "./verify-pr.ts";

describe("evaluatePrState", () => {
  test("CONFLICTING is reported as suppressed CI, not as passing checks", () => {
    const v = evaluatePrState({ mergeable: "CONFLICTING", checks: [{ name: "a", state: "pass" }] });
    expect(v.green).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/suppress/i);
  });

  test("a failing check is not green", () => {
    const v = evaluatePrState({ mergeable: "MERGEABLE", checks: [{ name: "x", state: "fail" }] });
    expect(v.green).toBe(false);
    expect(v.reasons.join(" ")).toContain("x");
  });

  test("pending is not green — not-yet-failed is not passed", () => {
    const v = evaluatePrState({ mergeable: "MERGEABLE", checks: [{ name: "y", state: "pending" }] });
    expect(v.green).toBe(false);
  });

  test("all pass + mergeable is green", () => {
    const v = evaluatePrState({ mergeable: "MERGEABLE", checks: [{ name: "a", state: "pass" }] });
    expect(v.green).toBe(true);
  });
});
```

- [ ] **Step 2: Run it, watch it fail**

```bash
bun test scripts/ci/verify-pr.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// scripts/ci/verify-pr.ts
export interface PrCheck { readonly name: string; readonly state: "pass" | "fail" | "pending" | "skipping" }
export interface PrState { readonly mergeable: string; readonly checks: readonly PrCheck[] }
export interface PrVerdict { readonly green: boolean; readonly reasons: readonly string[] }

/**
 * A CONFLICTING PR runs NO `pull_request` workflows, so its check list is not evidence of anything.
 * In #1038 that produced four green checks and a completely unverified branch. It is checked first
 * and reported explicitly, because the failure mode is "looks fine".
 */
export function evaluatePrState(s: PrState): PrVerdict {
  const reasons: string[] = [];
  if (s.mergeable === "CONFLICTING") {
    reasons.push("PR is CONFLICTING — pull_request workflows are SUPPRESSED; passing checks are not real coverage");
  }
  for (const c of s.checks) {
    if (c.state === "fail") reasons.push(`check failed: ${c.name}`);
  }
  const pending = s.checks.filter((c) => c.state === "pending").map((c) => c.name);
  if (pending.length > 0) reasons.push(`still pending (not yet failed is not passed): ${pending.join(", ")}`);
  return { green: reasons.length === 0, reasons };
}
```

Then a `main()` that shells out to `gh pr view --json mergeable,mergeStateStatus` and `gh pr checks`, maps them into `PrState`, prints the verdict, and exits per the table below.

**Wrap every `gh` call defensively.** `gh` prints human-readable text to stderr on rate limits, network failures, GitHub outages and auth problems — feeding that to `JSON.parse` produces an unreadable `SyntaxError: Unexpected token` stack trace that tells the user nothing about what actually went wrong. Required shape:

```ts
function ghJson(args: readonly string[]): unknown {
  const p = Bun.spawnSync(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const out = p.stdout.toString().trim();
  const err = p.stderr.toString().trim();
  if (p.exitCode !== 0) {
    throw new Error(`gh ${args.join(" ")} failed (exit ${String(p.exitCode)}): ${err || "no output"}`);
  }
  try {
    return JSON.parse(out) as unknown;
  } catch {
    throw new Error(`gh ${args.join(" ")} returned non-JSON output: ${out.slice(0, 200)}`);
  }
}
```

`main()` catches these and exits **2** with the message — never 0, and never a raw stack trace. A failure to query GitHub is "could not determine", which is a distinct outcome from both green and red.

- [ ] **Step 4: Exit semantics**

| State | Exit |
|---|---|
| Green | 0 |
| Any reason present | 1 |
| `gh` missing / unauthenticated | 2, with a message saying it could NOT determine state |
| No open PR for the branch | 1, message `no open PR for <branch> — nothing to verify` |

The last two matter: **"could not check" must never render as green.** A clean exit for "no PR" was suggested in review and rejected for exactly this reason.

- [ ] **Step 5: Verify against a real PR**

```bash
bun run verify:pr 1038 > /tmp/vp.log 2>&1; echo "EXIT=$?"; cat /tmp/vp.log
```

PR #1038 is merged, so expect a sensible report rather than a crash. Then run with no argument on this branch (no PR yet) and confirm exit 1 with the "no open PR" message, NOT a crash and NOT success.

- [ ] **Step 6: Commit**

```bash
git add scripts/ci/verify-pr.ts scripts/ci/verify-pr.test.ts package.json
git commit -m "feat(tooling): verify:pr — a conflicted or pending PR is never reported green"
```

---

## Self-Review

**Spec coverage.** §3.1 → Task 1. §3.2 → Task 6. §3.3 → Tasks 2 (cli, no baseline), 3 (logic), 4 (wiring). §3.4 → Task 7. §3.5 → Task 5. Delivery order in §5 matches Tasks 1 → 2 → 4 → 6 → 7, with Task 3 inserted before 4 because the baseline logic must exist before it can be wired.

**Deliberately not covered**, per §6: Sonar (no local equivalent), `audit:advisories` (time-dependent, correctly `CI_ONLY`), CodeRabbit findings (a reviewer, not a gate).

**Type consistency.** `ErrorCounts` (Task 3) is consumed by `evaluate`, `serializeBaseline` and `check.ts` (Task 4). `Violation`'s two `kind` values are produced in `baseline.ts` and consumed in `check.ts`'s printer. `assertDidWork` (Task 5) is called only by `run-gate-with-work-check.ts`. `PrState`/`PrVerdict` (Task 7) are local to that file. No symbol appears in two spellings.

**Every task ends red-proved where it adds a gate** — Tasks 2, 4, 5 and 6 each require watching the new check fail before trusting it. This repo has a history of guards that pass because they match the wrong thing.

**Known limitation carried from the spec:** the `(file, code)` baseline key means fixing one error while adding another of the same code in the same file nets zero and passes. Stated in `baseline.ts`'s doc comment so the next reader does not discover it by surprise.

---

## Review Disposition

Against [`2026-08-04-ci-feedback-loop-review.md`](./2026-08-04-ci-feedback-loop-review.md).

| # | Finding | Disposition |
|---|---|---|
| 1.1 | `apt-get` runs on every `verify:docker` invocation; estimated 15–30s | **Fixed — and it was worse than estimated. Measured 49.5s per run.** Task 6 now builds a cached `nimbus-verify:local` image containing the apt layer, with a `--rebuild` escape hatch. First run pays it once; every later run pays nothing. |
| 1.2 | `tsc` may emit absolute paths in some environments, mismatching baseline keys | **Fixed.** `parseTscOutput` takes an optional `repoRoot` and strips it; `check.ts` passes `REPO_ROOT`. Two regression tests added (absolute stripped, already-relative untouched). The baseline is generated on a dev machine and validated in a container, so this is a live risk, not theoretical. |
| 2.1 | "Biome natively parses JSONC for `biome.json`, so a comment is fine" | **Rejected — measured, and the opposite is true.** With a `//` comment in `biome.json`, biome checks **0 files and emits no parse error**; without it, the same config checks **3162**. It is a *silent* config mis-parse, the exact failure class this plan exists to remove. The plan now carries that evidence and keeps the rationale in the commit body. (`biome.jsonc` does support comments; renaming the config is out of scope.) |
| 2.2 | Wrap `gh` calls; validate JSON before parsing | **Fixed.** Task 7 specifies a `ghJson()` helper that checks the exit code, reports stderr, and converts a non-JSON body into a clear message instead of a `SyntaxError` stack. Failure exits **2** — "could not determine", distinct from both green and red. |

Two of the four were worth measuring rather than reasoning about: 1.1 was understated by ~2×, and 2.1
was confidently backwards. The other two were correct as written and are now in the plan.
