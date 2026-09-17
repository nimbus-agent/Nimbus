# Fleet subject enumeration — response to design review

> Review: `2026-09-17-fleet-subject-enumeration-review.md`. Spec: `2026-09-17-fleet-subject-enumeration-design.md`.
> Every finding was checked against code on the branch before disposition. **13 fixed, 0 deferred,
> 1 verified not-a-defect (a regression test added anyway).** Two fixes went further than the
> finding asked, because checking it exposed a wrong claim in the spec itself.

| # | Finding | Disposition | Where |
|---|---|---|---|
| Q1 | `paths` param ambiguous across roots | **Fixed.** `path` = absolute `path.join(root, rel)`; `resolveOwnershipPath` → `matchConfiguredRoot` accepts absolute input and resolves to exactly one root. | § 5.2 |
| Q2 | Directory/root representation, parent dedup | **Fixed, and the source changed.** Checking it showed `ownership-pass.ts` emits `source_file` (`file:<root>:<rel>`) and `directory` (`dir:<root>:<rel>`) nodes. Synthesising every parent from `git_blame_line` would emit directories with NO ownership node — briefs whose only content is the agent's "no ownership node" gap. `paths` now enumerates the pass's own nodes: distinct by construction (no dedup step to get wrong), root node reaches `matchRootItself`. | § 5.2, § 10, § 11 |
| Q3 | `symbol_prefix` semantics undefined | **Fixed by removal.** One narrowing key, `path_prefix`: case-sensitive plain prefix on the repo-relative POSIX path (`rel` for paths, the label's file part for symbols). A name-prefix filter had no use case the file filter does not serve better. | § 4, § 5.2 |
| Q4 | Sweep digest JSON undefined | **Fixed.** New additive `sweeps: FleetSweepDigest[]` sibling; `FleetJobDigest` NOT widened, since its non-optional predecessor fields are 2a's "no holes" guarantee. Config-named JSON stays byte-identical. | § 8.1 |
| E1 | Drive-letter case breaks key determinism | **Fixed differently — the spec's claim was the defect.** It claimed keys are equal across Windows and Linux; a `nimbus.db` is never shared across OSes, so that protects nothing. What must hold is stability across runs on one machine. Keys now reuse the ownership pass's external id verbatim. Lower-casing drive letters would make the key DISAGREE with the node it names. | § 6, § 11 |
| E2 | `--subject` without `--job` scans | **Fixed.** `idx_fleet_brief_subject (subject_key, created_at DESC)` added; cross-job subject history is legitimate (two jobs can sweep one subject). | § 6 |
| E3 | `ON CONFLICT` could clobber sweep columns | **Verified not a defect today** — `recordJobSuccess`/`recordJobFailure` use `DO UPDATE SET` with an explicit column list, which leaves unlisted columns untouched (`fleet-store.ts:156-183`). **Accepted the structural part:** dedicated `recordSweepEnumeration`/`advanceSweepCursor`, plus a regression test, since the next edit to either statement is where it would break. | § 6, § 11 |
| E4 | `subjects_*` for config-named jobs | **Fixed.** A config-named job counts as one subject, so the ratio is coherent across mixed runs. | § 6 |
| T1 | Subject index | Same as E2. | § 6 |
| T2 | Store methods | Same as E3. | § 6 |
| T3 | Truncation order / JSON completeness | **Fixed.** First 10 in `codeUnitCompare` order; truncation is Markdown-only, JSON carries every key. | § 8.1 |
| T4 | `FleetRunSummary` subject fields | **Fixed.** | § 6 |
| T5 | `stillAdmitted` counter unit | **Fixed.** One `subjectsAttempted` counter across both job kinds. | § 7 |

## A defect the review did not raise, found while checking Q3

The spec said a symbol label `"<name> — <file>"` is **unique per symbol**. It is not:
`filesystem-v2-sync.ts` builds the external id as `sym:<root>:<file>:<name>:<kind>`, but the label
drops kind and root. A same-named function and type in one file, or one file under two roots, share
a label, and `resolveMatchToken`'s exact arm takes `LIMIT 1`. **Disposition: stated as a bound, not
fixed** — the enumerator takes DISTINCT labels (one subject per collision), and § 10 says so.
Fixing it means changing what the agents' `file` parameter can express, which is an agent change
outside enumeration's scope.

## Verification checklist items

All four migration items, the three cursor items and the three digest items are already in § 11.
"Runs cleanly on V60/V61/V62 databases" is covered by construction: migrations apply sequentially,
so V63 only ever runs against a V62 schema, which the migrated-template test exercises.
