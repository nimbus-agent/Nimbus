# Fleet Subject Enumeration (PR 2b) — Implementation Plan Review

> **Target Plan:** [`2026-09-17-fleet-subject-enumeration.md`](file:///C:/gitrep/Nimbus/.claude/worktrees/fleet-subject-enumeration/docs/superpowers/plans/2026-09-17-fleet-subject-enumeration.md)  
> **Target Spec & Response:** [`2026-09-17-fleet-subject-enumeration-design.md`](file:///C:/gitrep/Nimbus/.claude/worktrees/fleet-subject-enumeration/docs/superpowers/specs/2026-09-17-fleet-subject-enumeration-design.md), [`2026-09-17-fleet-subject-enumeration-review-response.md`](file:///C:/gitrep/Nimbus/.claude/worktrees/fleet-subject-enumeration/docs/superpowers/specs/2026-09-17-fleet-subject-enumeration-review-response.md)  
> **Date:** 2026-09-17  
> **Review Scope:** Task breakdown (Tasks 1–9), TDD steps, SQL migrations, data structures, scheduler execution logic, digest partitioning, IPC/CLI contracts, and edge cases.

---

## 1. Executive Summary

The implementation plan is **exceptionally well-structured, comprehensive, and ready for execution**. It incorporates all 13 dispositions from the design review response, establishes clear TDD steps with red-proof gates, preserves backwards compatibility for config-named jobs (byte-identical Markdown and JSON), and provides exact code implementations for every task.

### Key Highlights of the Plan
1. **Incremental TDD Sequence:** Tasks 1 through 9 build systematically from database migration (V63) and store accessors up through configuration parsing, sweep enumerators, scheduler execution, digest rendering, IPC/CLI surfaces, and documentation.
2. **Clean Abstraction & Isolation:**
   - `FLEET_SWEEP_SUPPORT` enforces compiler-level totality over `EligibleAgentMethod`.
   - `selectSweepWindow` is a pure function isolated from I/O and tested across edge cases (wrapping, additions, deletions).
   - Sweep execution lives entirely inside `FleetScheduler.runSweepJob` while reusing existing `deps.invoke` and I38 budget tracking.
3. **Byte-Identity Preservation:** Config-named jobs render byte-identically in Markdown and JSON, protected by both unit tests and red-proof assertions.
4. **Resilience & Fault Isolation:** Broken subjects advance the cursor without stalling rotation; empty sweeps record success with descriptive reasons; unconfigured sweep jobs partition gracefully in the digest.

---

## 2. Micro-Refinements & Suggestions

While the plan is in great shape, here are a few minor observations and suggested micro-refinements to keep in mind during execution:

### 1. `enumerateSymbols` Label Splitting Fallback (Task 5, Step 4)
* **Current Code:**
  ```ts
  const at = label.lastIndexOf(SYMBOL_LABEL_SEPARATOR);
  const file = at === -1 ? "" : label.slice(at + SYMBOL_LABEL_SEPARATOR.length);
  if (!file.startsWith(pathPrefix)) continue;
  ```
* **Observation:** In some integration tests or edge cases, `graph_entity` symbol labels might be written as bare filenames (e.g. `src/auth.ts` without the `" — "` separator). If `at === -1`, setting `file = ""` causes any symbol without `" — "` to be discarded when `pathPrefix` is non-empty.
* **Suggestion:** Fall back to `label` when no separator is found:
  ```ts
  const file = at === -1 ? label : label.slice(at + SYMBOL_LABEL_SEPARATOR.length);
  ```

### 2. Trimming `path_prefix` in TOML Parser (Task 3, Step 3)
* **Current Code:** `cur.pathPrefix = parseString(valRaw);`
* **Observation:** If a user accidentally writes `path_prefix = ""` (empty string) or trailing whitespace, `d.pathPrefix` is passed as `""`.
* **Suggestion:** Normalize `path_prefix` in `resolveSweep` so that an empty/whitespace string is normalized or treated cleanly:
  ```ts
  const prefix = d.pathPrefix?.trim();
  return { kind, maxSubjects: n, pathPrefix: prefix && prefix.length > 0 ? prefix : null };
  ```

### 3. Verification of `oldestInWindow` WHERE Clause (Task 2, Step 3)
* When updating `briefPairForSubject` in `fleet-store.ts`, ensure `oldestInWindow` includes `AND subject_key = ?` in its SQL query:
  ```sql
  WHERE job_id = ? AND subject_key = ? AND created_at >= ? AND created_at <= ? AND id != ? AND expires_at > ?
  ORDER BY created_at ASC, id ASC LIMIT 1
  ```
  And passes `q.subjectKey` in its query parameters array `[q.jobId, q.subjectKey, q.windowStartMs, current.createdAt, current.id, q.now]`. (The plan mentions this in the text of Task 2 Step 3).

---

## 3. Task-by-Task Verification Matrix

| Task | Core Responsibility | Key Invariants Verified | Risk Level |
|---|---|---|---|
| **Task 1** | Schema V63 Migration & `subject_key` | Table rebuild keeps `ON DELETE CASCADE`; `subject_key = job_id` backfill | Low |
| **Task 2** | `FleetStore` Subject Reads & Sweep State | Cursor preservation under same kind; reset on kind change; `briefPairForSubject` | Low |
| **Task 3** | Config Parsing (`sweep`, `max_subjects`, `path_prefix`) | Rules 3–5 enforced; integer bounds `1..500`; reserved keys filtered from params | Low |
| **Task 4** | `FLEET_SWEEP_SUPPORT` & Load Validation | Rules 1, 2, 6 enforced; totality over `EligibleAgentMethod`; `negotiate` deferred | Low |
| **Task 5** | The Four Sweep Enumerators | Multi-root path disambiguation via `fileExternalId`/`dirExternalId`; distinct symbols | Medium |
| **Task 6** | Scheduler `runSweepJob` & Window Rotation | Cursor wrap-around; mid-sweep yield without success; per-subject admission re-probe | Medium |
| **Task 7** | Digest Grouping & Rendering | Config-named byte identity; sweep consolidation into `sweeps`; rotation vs retention | Medium |
| **Task 8** | IPC & CLI Surfaces | `fleet.briefs --subject`; `fleet.list` sweep progress & warnings | Low |
| **Task 9** | Documentation & PR Prep | Clean sync across all docs; removal of plan/spec files before merge | Low |

---

## 4. Conclusion

The plan is approved and ready for step-by-step execution. Proceed with Task 1 (`feat(fleet): V63 — subject_key on fleet briefs, sweep state columns`) following the specified TDD workflow and red-proof steps.
