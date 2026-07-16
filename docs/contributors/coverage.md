# Coverage Floor — Contributor Guide

This project enforces a **per-file 80% line-coverage floor** for every bun-tested workspace package (gateway, cli, sdk, client, mcp-connectors). A CI gate fails any PR that introduces a non-exempt source file below 80% or regresses a baselined file below its recorded watermark.

## Phase 0 scope

Phase 0 covers the bun-tested packages only:

- `packages/gateway`
- `packages/cli`
- `packages/mcp-connectors/*`

UI (`packages/ui`) uses Vitest, which emits its own `coverage/lcov.info`. That file is not yet merged into the gate's input; the existing Vitest `>=80% lines / >=75% branches` thresholds keep that surface honest. A future phase can extend the floor to UI by merging the Vitest lcov into `coverage/lcov.info` before the gate runs.

`packages/docs` has no tests; it is out of scope by construction.

## How the gate works

CI runs `bun run audit:coverage-floor` after the unit-test step in `_test-suite.yml`. The script:

1. Reads `coverage/lcov.info` (the merged workspace lcov produced by the per-package merge earlier in the same CI step).
2. Walks the bun-tested package source trees independently of the lcov — a source file absent from lcov is treated as 0% covered (Bun's V8 coverage only emits entries for imported files, so untested files would otherwise be invisible).
3. Filters out exempt paths (see [`scripts/coverage-floor/exclusions.ts`](../../scripts/coverage-floor/exclusions.ts)).
4. Compares actual coverage against the ratcheting baseline at [`docs/structure-audit/coverage-baseline.json`](../structure-audit/coverage-baseline.json).
5. Exits non-zero on any violation, surfacing each as a `::error file=...::` annotation so it appears inline on the PR diff.

## Violation kinds and how to fix them

### `below_floor` — new file is below 80%

A non-baseline source file came in below 80%. Add tests until the file reaches >=80%.

### `missing_from_lcov` — file has no coverage data

The file exists in one of the in-scope package source trees but no test imports it. Either:

- Write a test for it (preferred); or
- Add it to the baseline at 0% (`bun run audit:coverage-floor:update-baseline` — only valid if you also commit to climbing the watermark in subsequent PRs).

### `regression` — baseline file dropped

Your changes lowered a baseline file's coverage. Two options:

1. Restore the lost coverage by adding/restoring tests in this PR; OR
2. Identify the deleted code that produced the apparent regression (e.g., a dead function was removed and its tests with it); in that case the regression is real but expected. Discuss with reviewers before pushing forward — the ratchet exists to catch silent regressions, so legitimate drops need a paper trail.

The script never auto-lowers a baseline. Watermarks are monotonically non-decreasing.

### `must_raise` — baseline file improved; baseline must follow

Your changes raised a baseline file's coverage above its recorded watermark. The baseline file must be updated in the same PR — otherwise a later PR could regress back to (old_baseline + 1)% without tripping the gate. Run:

```bash
bun run audit:coverage-floor:update-baseline
```

…then commit the updated `docs/structure-audit/coverage-baseline.json`.

### `must_remove` — baseline file reached 80%

A baselined file now meets the full floor. The baseline entry must be removed in the same PR. Same fix as `must_raise`:

```bash
bun run audit:coverage-floor:update-baseline
```

The script raises must-raise entries and drops must-remove entries in one pass.

### `below_target` — a flagship 100% file slipped below its pinned ceiling

A handful of security-core files are pinned at **100% line AND branch** via the `targets` section of `docs/structure-audit/coverage-baseline.json` (separate from the `files` debt map). These are the load-bearing invariant sites — e.g. `engine/executor.ts` (the HITL consent gate, I2/I3/I4) and `engine/tool-output-envelope.ts` (the LLM-facing `wrapToolOutput` envelope, I11). The gate flags `below_target` when such a file drops below its required pct on either axis.

The fix is **never** to lower the target — add tests until the file is back at 100/100. For a genuinely-unreachable arm, prefer the [§5 unreachable-branch policy](../superpowers/specs/2026-06-07-true-coverage-program-design.md): a type-safe refactor that removes the dead branch (e.g. replace a provably-dead `?? fallback` with a typed helper), **not** `istanbul ignore` / `biome-ignore`. The `targets` section is hand-curated and is round-tripped untouched by `update-baseline` — a reseed can never silently relax a 100% ceiling. A target path must never also appear in `files` (the two carry contradictory intent; `parseBaseline` rejects it).

## OS-specific code

The PR gate runs on Ubuntu only. Files with inline `process.platform === "win32"` branches will show the `win32` arm as uncovered.

**Preferred:** refactor OS-specific logic into `packages/gateway/src/platform/{win32,darwin,linux}.ts` per `nimbus-architecture.md`. Those files are exempt from the floor by construction.

**Fallback:** add the file to the baseline at its current Ubuntu coverage. Future work (out of scope for the foundation PR) can extend `check.ts` to merge per-OS lcov from the 3-OS push matrix so the cross-OS branch counts as covered.

Comment-based ignores (`/* c8 ignore next */`, `/* istanbul ignore next */`) are **not** supported. Bun's V8 coverage doesn't recognize these markers.

## Requesting an exclusion

If a file is structurally untestable in a single CI run (top-level side effects, OS-specific bindings, code-generation outputs), open a PR that:

1. Adds the path to [`scripts/coverage-floor/exclusions.ts`](../../scripts/coverage-floor/exclusions.ts) with a comment explaining why.
2. Mirrors the same path in `sonar-project.properties`' `sonar.coverage.exclusions` (drift between the two is caught by `audit:exclusion-parity`).
3. Removes the path's entry from [`docs/structure-audit/coverage-baseline.json`](../structure-audit/coverage-baseline.json) if it had one.

Exclusions are a last resort — prefer testability refactors (extract pure helpers to a sibling file, as PR #326 did for `setOutput`).

## Bun Workers (separate realm)

Worker entry files (`db/query-guard-worker.ts`, `embedding/embedding-worker.ts`) are excluded. Bun Workers run in a separate realm that the Istanbul `[test].preload` plugin never reaches, so the worker body accrues no entries in the main realm's `globalThis.__coverage__` — the same blind spot Bun's native `--coverage` has. The general remedy is the one used elsewhere in this program: extract the meaningful orchestration into a sibling module that runs in the main (testable) realm. Task 4 did exactly that for the embedding worker (`embedding/embedding-worker-core.ts`, unit-tested, not excluded); `query-guard-worker.ts`'s security check already lives in `platform/worker-security.ts`. What remains in each worker entry is a thin wiring shell.

A §5.3 probe (D3, 2026-06-14) confirmed a worker-realm flush is technically possible: spawning the worker with Bun's `preload:` option to re-register the `babel-plugin-istanbul` Bun loader inside the worker realm produced a valid Istanbul map (real `branchMap`, real branch hits), which then merged cleanly back into the main realm's `globalThis.__coverage__` for `report-coverage.ts` to shard. It was deliberately not wired durably: doing so would thread a test-only `preload:` injection seam plus a coverage post-back/merge protocol through the two production worker spawn sites (`db/query-guard.ts`, `embedding/worker-bridge.ts`) and each worker's `onmessage` contract — invasive cross-realm scaffolding inside production I/O shells, and a divergence from Bun-native `--coverage` parity, for negligible gain now that the substantive logic is extracted and tested. If a future worker grows non-trivial in-realm logic that cannot be extracted, revisit this probe.

## Updating the baseline (cross-platform note)

The seeded baseline is **Linux-platform-specific**. CI runs the gate on Ubuntu, and Bun's V8 coverage exercises different code paths on different OSes — a Windows-only `vault/win32.ts` branch is uncovered on Linux, and vice versa. A local `bun run audit:coverage-floor:update-baseline` on macOS or Windows will produce a baseline that disagrees with CI by tens of percent on platform-specific files.

**Canonical workflow:** push your PR, let CI run, then:

```bash
# 1. Find the latest run on your branch
gh run list --branch <your-branch> --limit 1

# 2. Download the merged coverage lcov from that run
gh run download <run-id> --name coverage-lcov-merged --dir coverage

# 3. Regenerate the baseline against CI's lcov
bun run audit:coverage-floor:update-baseline

# 4. Commit + push
git add docs/structure-audit/coverage-baseline.json
git commit -m "chore(coverage-floor): refresh baseline from CI lcov"
git push
```

The `coverage-lcov-merged` artifact is published by every Linux CI run (retention 7 days) for exactly this purpose.

If you don't have CI access (e.g. you're working offline), `bun run audit:coverage-floor:build-lcov` produces a local lcov that's approximately correct; expect to refine the baseline via CI on push.

## Running the gate locally

```bash
bun run audit:coverage-floor:build-lcov            # per-package bun test + lcov merge (reproduces CI input; ~70s)
bun run audit:coverage-floor                       # the gate
bun run audit:coverage-floor:update-baseline       # raise + remove diffs
bun run audit:exclusion-parity                     # sonar drift check
```

The full CI parity command is `bun run test:ci`.

Note: the root `bun run test:coverage` script does not produce `coverage/lcov.info` — it omits `--coverage-reporter=lcov` and Bun only emits lcov when invoked from inside a workspace package. `audit:coverage-floor:build-lcov` is the canonical local entry point.
