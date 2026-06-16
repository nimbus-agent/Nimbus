# Review & Suggestions — Perf Drift-Check Wiring Implementation Plan

**Reviewer:** AI Coding Assistant (Antigravity)  
**Date:** 2026-06-16  
**Target Plan:** `2026-06-16-perf-drift-wiring.md`

This document details feedback, verification points, and small improvements for the Perf Drift-Check Wiring Implementation Plan.

---

## 1. Plan Verification & Edge Cases

### A. Retention of `GhIssue` Definition in `drift-check.ts`

* **Observation**: In Task 5 (Step 3), the plan notes to "delete `ghSpawn` + `ghIssueList`" and rewrite `upsertDriftIssue` to accept `existingIssues: GhIssue[]`.
* **Suggestion**: The plan does not explicitly mention keeping the `GhIssue` interface definition in `drift-check.ts`. To avoid a compiler error, ensure the step retains:

  ```ts
  interface GhIssue {
    number: number;
    title: string;
  }
  ```

  or imports/aliases the type returned by `GhCli.issueList`. Keeping it as a local interface in `drift-check.ts` is the simplest path.

### B. Inconsistency in `DRIFT_NOISE_FLOOR_PCT`

* **Observation**: The Design Spec (§2) lists `DRIFT_NOISE_FLOOR_PCT=20`, whereas the Implementation Plan (Task 5 / Notes) specifies `DRIFT_NOISE_FLOOR_PCT=10`.
* **Verification**: The codebase currently defines `const DRIFT_NOISE_FLOOR_PCT = 10;`. The implementation plan correctly notes that thresholds are "untouched" and should stay at `10%` to match existing behavior. We should proceed with `10%` as outlined in the plan.

### C. Mock Spawn Return in `fakeGh` Test helper

* **Observation**: In Task 5 (Step 1), the `fakeGh` test helper mocks the `GhSpawnFn` by returning `{ exitCode: 0, stdout: "", stderr: "" }` for artifact download.
* **Impact**: This is highly correct. Since `GhCli` internally wraps `Bun.spawn` via its constructor `spawn` option, returning exit code `0` causes the high-level `GhCli.runDownloadArtifact` method to resolve to `true`, which perfectly validates the file-creation flow on the filesystem.

---

## 2. Strengths of the Plan

### A. Idempotent Label Creation

* **Impact**: The inclusion of `gh label create perf-drift --force` in `.github/workflows/_perf-drift.yml` is an excellent design choice. It solves the missing-label issue idempotently, ensuring the GHA run never crashes if the label is absent, without needing manual setup in repository settings.

### B. Prevention of Comment Spam

* **Impact**: Transitioning the upsert logic to a create-only behavior (`if (existingIssues.some(...)) return`) prevents GitHub issue notification noise entirely. This ensures the daily cron job only acts when a new regression is identified, without clogging existing open issues with repeated comments.
