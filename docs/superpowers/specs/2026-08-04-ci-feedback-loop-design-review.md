# Design Review: Closing the local-vs-CI feedback gap

This document contains a design review of the [2026-08-04-ci-feedback-loop-design.md](./2026-08-04-ci-feedback-loop-design.md) specification, detailing open questions, suggestions, and potential improvements.

---

## 1. Open Questions

### 1.1 Biome Glob Anchoring vs. Main Workspace Scanning

The proposed change in `biome.json` changes `"!**/.claude"` to `"!.claude"`.

* **The Question**: If a developer runs `bun run lint` (or `preflight`) from the **main workspace root**, does the `"!.claude"` pattern allow Biome to descend into `.claude/worktrees/*` and scan all nested files inside active worktrees?
* **Impact**: If it does, running lint at the root might cause Biome to scan duplicate code bases, unstaged worktree files, or conflicting setups across all checked-out branches, heavily bloating execution time and producing false-positive failures.
* **Suggestion**: Verify if we need to explicitly ignore `.claude/worktrees/` or `.claude/worktrees/**/*` while unignoring `.claude/` for when biome is executed inside a worktree itself.

### 1.2 Baseline Path Separators and Normalization

TS typecheck errors include file paths relative to the monorepo root (e.g., `packages/gateway/test/...` or `packages\gateway\test\...` depending on OS/shell).

* **The Question**: How will the parser handle path separators when generating or validating keys for the baseline?
* **Impact**: If Windows uses backslashes `\` and Linux uses forward slashes `/`, a baseline generated on Windows will mismatch and fail when run in a Linux container (or vice-versa).
* **Suggestion**: Explicitly specify that the baseline key generator must normalize all relative paths to use forward slashes `/` regardless of the host OS.

### 1.3 `verify:pr` Behavior when PR is Not Yet Opened

The spec defines `bun run verify:pr [<pr-number>]`.

* **The Question**: How does this command behave if no `<pr-number>` is provided, and the user has not yet opened a PR for the current branch?
* **Impact**: If `gh pr view` fails due to the PR not existing, does `verify:pr` report this as a hard error or exit gracefully with a warning?
* **Suggestion**: If no PR exists for the current branch, exit with a clean message (e.g., `No open PR found for branch dev/...; skipping PR status verification.`) rather than a hard crash.

---

## 2. Improvements & Suggestions

### 2.1 Deterministic Sorting of the Baseline JSON

To prevent git diff churn when the baseline is updated or regenerated:

* **Improvement**: The JSON output written to `docs/structure-audit/typecheck-tests-baseline.json` must sort keys alphabetically before writing to disk.
* **Why**: Ensures that any modifications, additions, or removals of TS errors produce a clean, readable git diff.

### 2.2 Standardizing the "Zero Work" Assertion in `PREFLIGHT_GATES`

To implement "zero work is a failure" cleanly across all gates without duplicating logic in both `verify-in-docker.sh` and the local preflight runner:

* **Improvement**: Extend the `Gate` schema in `scripts/lib/preflight-gates.ts` to include optional metadata for verifying work units, such as:

  ```typescript
  interface Gate {
    name: string;
    cmd: string[];
    // Regex matching the progress/work count (e.g., /Processed (\d+) files/)
    workCountRegex?: RegExp;
    // Expected minimum count, defaults to 1
    minWorkUnits?: number;
  }

  ```

* **Why**: Centralizing the assertions in the manifest definition makes the rule declarative, testable via `preflight.test.ts`, and easily consumable by both runners.
