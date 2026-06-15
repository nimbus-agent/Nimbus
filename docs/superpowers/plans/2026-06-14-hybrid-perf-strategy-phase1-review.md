# Review & Suggestions — Hybrid Perf Strategy Phase 1 Plan

**Reviewer:** AI Coding Assistant (Antigravity)  
**Date:** 2026-06-14  
**Target Plan:** `2026-06-14-hybrid-perf-strategy-phase1.md`

This document details feedback, open questions, and recommended improvements for the Hybrid Perf Strategy Phase 1 Implementation Plan.

---

## 1. Recommendations & Improvements

### A. Safety Guard in JSON Parsing of `gh` Output (Task 9 Step 3)

* **Context**: In `drift-check.ts`, `ghIssueList` calls `JSON.parse(out)` directly on the stdout of `gh issue list`.
* **Issue**: If the stdout contains debug warnings, rate-limiting notices, or network error messages before the JSON payload, `JSON.parse` will throw and crash the entire drift checker run.
* **Recommendation**: Wrap `JSON.parse` in a try/catch block to gracefully return `[]` or log the error, preventing process crash:

  ```ts
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch (err) {
    stderr(`drift-check: failed to parse issue list JSON: ${errMsg(err)}`);
    return [];
  }
  ```

### B. Simplification of Conditional Map Types (Task 9 Step 3)

* **Context**: `TREND_METRIC_BY_SURFACE` uses a highly complex conditional infer type.
* **Recommendation**: Directly declare it as `ReadonlyMap<BenchSurfaceId, keyof HistoryLineSurface>` to simplify readability and prevent potential compilation speed bottlenecks in TypeScript's type checker.

### C. Flat over flatMap (Task 4 Step 3)

* **Context**: `ranked.slice(0, -1).flatMap((r) => r)` is used to flatten the arrays.
* **Recommendation**: Standardize on `ranked.slice(0, -1).flat()` as it is more idiomatic and concise, and aligns with standard JS practices.
