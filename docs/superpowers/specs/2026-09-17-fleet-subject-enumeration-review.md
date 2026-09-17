# Fleet Subject Enumeration (S2 Fleets, PR 2b) — Design Review

> **Target Spec:** [`2026-09-17-fleet-subject-enumeration-design.md`](file:///C:/gitrep/Nimbus/.claude/worktrees/fleet-subject-enumeration/docs/superpowers/specs/2026-09-17-fleet-subject-enumeration-design.md)  
> **Date:** 2026-09-17  
> **Review Scope:** Data model & migration V63, enumerator contracts, scheduler mechanics, digest grouping & rendering, config validation, and edge case handling.

---

## 1. Executive Summary & Architectural Assessment

The design for PR 2b (**Fleet Subject Enumeration**) is rigorous, sound, and aligns directly with the architectural patterns established in PR 1 (`FLEET_ELIGIBILITY`, V60, I38) and PR 2a (digest extractors, min-delta thresholding). 

### Key Strengths of the Design
1. **Total Mapping & Type Safety:** Modeling `FLEET_SWEEP_SUPPORT` as a total mapping over `EligibleAgentMethod` (with explicit reasons for non-enumerable agents) matches the discipline of `FLEET_DIGEST_EXTRACTORS`.
2. **Safe Privacy Boundary:** Explicitly rejecting person-level enumeration (keeping `negotiate` deferred) prevents unattended, unsanctioned dossier-building across the organization.
3. **Robust Cursor Semantics:** Using a strictly-greater key-based cursor (`key > cursor` with `codeUnitCompare` sort) rather than ordinals cleanly handles file insertions, deletions, and renames without skipping or looping.
4. **Execution-Time Fan-out:** Executing sweeps inside `FleetScheduler` rather than expanding virtual jobs at config load avoids configuration state explosion, preserves single-flight locking, and maintains unified I38 budget tracking.

---

## 2. Open Questions & Ambiguities

### Q1. Exact Path Formatting & Parameter Passing for `paths` Enumerator (§ 5.2)
* **Context:** `paths` enumerator emits `SweepSubject = { key: string; params: Record<string, string> }` for agent `ownership`.
* **Ambiguity:** What exact value is passed in `params.path` vs `key`?
  - `key` is specified as `paths:<repo_root posix>/<file_path posix>`.
  - If `params.path` is just `<file_path>` (e.g. `src/auth.ts`) and multiple roots are registered (e.g. `/repo-a` and `/repo-b`), `resolveOwnershipPath` will match the first root containing that relative path.
* **Recommendation:** Explicitly specify that `params.path` passes the full canonical path (or `join(repo_root, file_path)`), which `resolveOwnershipPath` resolves unambiguously to the correct root.

### Q2. Directory Representation & Repo Root in `paths` Enumerator (§ 5.2)
* **Context:** The spec states: *"distinct `(repo_root, file_path)` from `git_blame_line`, plus each file's parent directories"*.
* **Questions:**
  1. How is the repository root itself represented? Is its key `paths:<repo_root posix>` or `paths:<repo_root posix>/`?
  2. For a file `packages/gateway/src/index.ts`, parent directories are `packages/gateway/src`, `packages/gateway`, `packages`, and `""` (root). Are all parents emitted?
  3. Parent directories will overlap heavily across thousands of files. The spec should explicitly note that parent directories **must be deduplicated** prior to window sorting and slicing.

### Q3. Semantics and Filtering for `symbol_prefix` (§ 4, § 5.2)
* **Context:** § 4 mentions `symbol_prefix` as a reserved keyword and refusal rule 5 mentions `symbol_prefix` on `symbols`. However, § 5.2 does not specify how `symbol_prefix` filters candidates.
* **Questions:**
  - Graph symbol labels have the format `"<name> — <file>"`. Does `symbol_prefix = "auth"` match `label.startsWith("auth")` (symbol name), or does it match the file path component?
  - Is `symbol_prefix` case-sensitive or case-insensitive?
* **Recommendation:** Define `symbol_prefix` matching behavior in § 5.2 (e.g. case-sensitive prefix match on the `graph_entity.label`).

### Q4. JSON Structure for Sweep Digests in `--json` (§ 8.1, § 8.2)
* **Context:** The spec states that sweep jobs render one consolidated section and that `--json` shapes are additive.
* **Question:** How does `FleetDigestResult` represent sweep jobs in JSON?
  - Config-named jobs yield a `FleetJobDigest` in `jobs: FleetJobDigest[]`.
  - For a sweep job, does `FleetJobDigest` gain sweep-specific fields (e.g., `sweepKind`, `subjectsTotal`, `subjectsSwept`, `rotationDays`, `movedSubjects`, `unchangedCount`), or is there a distinct `sweeps: FleetSweepDigest[]` field?
* **Recommendation:** Document the TypeScript interface for sweep digests in § 8.1 so the `--json` schema is unambiguous.

---

## 3. Potential Edge Cases & Failure Modes

### E1. Cross-Platform POSIX Normalization on Windows (§ 6)
* `git_blame_line` stores `repo_root` with OS paths (e.g. `C:\gitrep\Nimbus` on Windows).
* In JavaScript, `codeUnitCompare` sorts uppercase drive letters (`"C:/"`) before lowercase (`"c:/"`).
* **Fix:** Ensure the POSIX conversion helper systematically normalizes Windows drive letters (e.g. lowercase `c:/`) and replaces backslashes so keys remain 100% deterministic across sync passes and platforms.

### E2. Standalone `nimbus fleet briefs --subject <key>` Indexing (§ 6, § 8.2)
* In V63, `idx_fleet_brief_job` is updated to `(job_id, subject_key, created_at DESC)`.
* If a user runs `nimbus fleet briefs --subject paths:src/auth.ts` without specifying `--job`, SQLite cannot use `idx_fleet_brief_job` because `job_id` is the leading column, leading to a full table scan on `fleet_brief`.
* **Fix:** Add index `idx_fleet_brief_subject ON fleet_brief (subject_key, created_at DESC)` in V63 DDL.

### E3. Preserving Sweep State in `FleetStore` Mutations (§ 6, § 7)
* When `recordJobSuccess` or `recordJobFailure` runs on `fleet_job_state`, it executes an `INSERT ... ON CONFLICT(job_id) DO UPDATE SET ...`.
* **Risk:** The `ON CONFLICT` clause must not overwrite or null out `sweep_kind`, `sweep_cursor`, or `sweep_subjects_total`.
* **Recommendation:** Add dedicated store methods (e.g. `updateSweepCursor(jobId, cursor, total)` and ensure `recordJobSuccess`/`recordJobFailure` preserve sweep columns).

### E4. `subjects_*` Accounting for Config-Named Jobs (§ 6)
* `fleet_run` gains `subjects_in_scope`, `subjects_attempted`, `subjects_completed`.
* **Question:** For a config-named job (which has 1 subject: itself), do these counters record `0` or `1`?
* **Recommendation:** Set `subjects_*` to reflect the total units of subject evaluation across all jobs in scope (1 per config-named job + N per sweep job window) so that `subjects_completed / subjects_attempted` is a coherent metric across all run types.

---

## 4. Specific Suggestions & Enhancements

| Area | Current Spec | Proposed Improvement | Rationale |
|---|---|---|---|
| **Schema Indexing** | `(job_id, subject_key, created_at DESC)` | Add `CREATE INDEX idx_fleet_brief_subject ON fleet_brief (subject_key, created_at DESC)` | Enables fast lookup for `nimbus fleet briefs --subject <key>` without `--job`. |
| **Store Methods** | Implicit in scheduler loop | Add `FleetStore.advanceSweepCursor(jobId, cursor)` and `updateSweepTotal(jobId, total)` | Decouples cursor progression after each subject from run completion/failure. |
| **Digest Truncation** | "first 10 keys and ... and N more" | Clarify that the first 10 keys are sorted by `codeUnitCompare`, and specify if `--json` includes all keys or the sample | Ensures deterministic rendering across machines and clarifies machine-readable contract. |
| **`FleetRunSummary`** | Only has `jobs*` fields | Add `subjectsInScope`, `subjectsAttempted`, `subjectsCompleted` to `FleetRunSummary` | Allows RPC callers and CLI output to display subject progress without raw DB queries. |
| **`stillAdmitted` Counter** | Counted in subjects | Count total units of work across both config-named jobs and sweep subjects in `stillAdmitted(attempted, force)` | Ensures host activity is checked consistently at every unit boundary regardless of job type. |

---

## 5. Verification Checklist for Implementation

- [ ] **Migration V63:**
  - [ ] Migration runs cleanly on V60/V61/V62 databases.
  - [ ] Rebuilt `fleet_brief` preserves `ON DELETE CASCADE` from `fleet_run`.
  - [ ] Existing briefs backfill `subject_key = job_id`.
  - [ ] `CURRENT_SCHEMA_VERSION` bumped to `63`.
- [ ] **Cursor Robustness:**
  - [ ] Window wraps cleanly from end of key list to beginning.
  - [ ] Deleted subjects mid-rotation do not stall the cursor.
  - [ ] Failed subjects advance the cursor so broken subjects do not pin the rotation.
- [ ] **Digest Output:**
  - [ ] Config-named jobs produce byte-identical markdown to PR 2a golden fixtures.
  - [ ] Sweep jobs produce single consolidated section with coverage line, moved subjects, unchanged count, and truncated first observations.
  - [ ] No model call is made at any point in digest computation (I38).
