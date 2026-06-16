# Review & Suggestions — Perf Drift-Check Wiring Design Spec

**Reviewer:** AI Coding Assistant (Antigravity)  
**Date:** 2026-06-16  
**Target Spec:** `2026-06-16-perf-drift-wiring-design.md`

This document details feedback, open questions, and recommended improvements for the Perf Drift-Check Wiring Design Spec.

---

## 1. Major Feedback & Suggestions

### A. Github Issue Label Lifecycle Verification

* **Issue**: The spec states in §7 that: "The `perf-drift` issue label is created on first use by `gh issue create --label` (or pre-created in the repo)."
* **Detail**: In standard GitHub CLI operations, passing `--label <label>` to `gh issue create` does *not* automatically create a missing label in the repository. If the label does not exist, the command will either fail or drop the label depending on the environment.
* **Suggestion**: We should either:
  1. Pre-create the `perf-drift` label in the repository settings manually before merging the PR.
  2. Or, add a defensive creation step using `gh label create perf-drift --color <color> --description <description> --force` (or wrapped in a try/catch) prior to creating the issue in the script.

### B. Mitigating Issue Comment Noise (Spam)

* **Issue**: The scheduled workflow runs daily at 06:00 UTC. If a regression persists and is unresolved for several days or weeks, the script will find the existing open issue and call `GhCli.issueComment` daily.
* **Detail**: This will result in daily duplicate comments with static text: `"Drift re-detected on..."` which clutters the issue timeline with redundant noise.
* **Suggestions**:
  * **Option 1 (Throttling)**: Avoid adding comments if the last comment on the issue was posted within the last 3 days or 3 runs.
  * **Option 2 (Informative Metrics)**: Instead of a static message, make the comment informative by appending the current p95/median values, the percentage deviation, and a list of new commits since the last run.
  * **Option 3 (No Daily Comments)**: If the issue is already open, do not post any follow-up comments unless the drift recovers and then regresses again.

### C. Issue Resolution (Auto-Closing)

* **Issue**: The spec defines when an issue is created or commented on, but it does not specify how or when an issue is resolved and closed.
* **Detail**: If a developer fixes the performance regression, the daily run will no longer detect drift. However, the issue will remain open indefinitely until manually closed.
* **Suggestion**:
  * Consider adding an auto-close mechanism. If the drift detector returns `false` (no drift) for a surface that has an open issue with the `perf-drift` label, the script could post a final comment: `"Performance drift resolved. Closing issue."` and automatically close it using `gh issue close <number>`.
  * Alternatively, if manual verification/close is preferred (to prevent flapping), the spec should explicitly state that issue resolution and closure is a manual process.

---

## 2. Praise & Core Successes

### A. Fixing the History Duplication Bug

* **Detail**: In the existing `drift-check.ts` codebase, `parseHistoryLines` reads and parses *every* line of the downloaded `run-history.jsonl` files. Since each run's artifact contains the full accumulated history up to that point, combining all lines from multiple runs results in severe duplicated history records.
* **Impact**: Extracting `parseLastHistoryLine` to parse only the latest line of each run's artifact (as described in §3.4 and §3.3) correctly fixes this duplication issue and ensures a clean, chronological time-series.

### B. Strict Security Scoping

* **Impact**: The proposed `.github/workflows/_perf-drift.yml` permissions are scoped defensively (`contents: read`, `actions: read`, `issues: write`), which satisfies all GitHub security standards and prevents unauthorized escalation.
