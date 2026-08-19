# Design Review Response: PR changed-file indexing

Response to [`2026-08-19-pr-changed-file-indexing-design-review.md`](./2026-08-19-pr-changed-file-indexing-design-review.md).
Every item checked against the tree on 2026-08-19 before being accepted or declined.

**Outcome:** 5 accepted, 0 deferred, 0 rejected — but two were accepted with a *different
mechanism* than proposed, and one carried a defect in its own suggested code that would have
shipped a silent bug into W6-B.

| # | Item | Outcome | Spec change |
| --- | --- | --- | --- |
| 1.1 | `local_file_id` lifecycle on delete/untrack | **Accepted — schema, not prose** | § 4.3 |
| 1.2 | Cleanup of orphaned rows via cascade | **Accepted — and it re-keyed both tables** | § 4.1, § 4.2 |
| 1.3 | Canonical negation SQL template | **Accepted; template CORRECTED** | § 4.4 (new) |
| 2.1 | Batch inserts | **Accepted, with transaction scope pinned** | § 5.3 (new) |
| 2.2 | `per_page=100` and forge page sizes | **Accepted** | § 5.1 |

---

## 1.1 — `local_file_id` lifecycle: a real gap, with a better answer than the one proposed

The question is correct and the spec did not answer it. It said `local_file_id` was "refreshable"
and said nothing about what happens when the entity it points at is deleted.

**Verified this is not hypothetical:** `ownership/ownership-pass.ts`'s `reapOrphansForRoot` really
does `DELETE FROM graph_entity` for degree-0 `source_file` and `directory` rows, so untracking a
workspace removes exactly the rows this column references.

The review suggested the ownership pass should nullify dangling references. **Declined in favour of
`REFERENCES graph_entity(id) ON DELETE SET NULL`** — same outcome, enforced by the database rather
than by a pass remembering to do it. A rule that lives in one subsystem's code is a rule the next
subsystem to delete an entity will not know about; a constraint on the column binds every writer,
including ones written later. It also lands the row in exactly the state it already has for a repo
that was never cloned, so no new state exists to reason about.

---

## 1.2 — cascade cleanup: accepted, and it improved the primary key

I was prepared to reject this. `ON DELETE CASCADE` in SQLite is inert unless
`PRAGMA foreign_keys = ON` is actually set, and plenty of codebases never set it — a cascade that
silently never fires is worse than no cascade, because it reads as cleanup that is not happening.

**Checked, and it is on:** `index/local-index.ts`, `db/repair.ts`, `db/verify.ts` and
`embedding/embedding-worker.ts` all issue `PRAGMA foreign_keys = ON`, and the schema already uses
this pattern — `index/deployment-v28-sql.ts` and `index/embedding-v6-sql.ts` both declare
`REFERENCES item(id) ON DELETE CASCADE`.

Accepting it changed the design for the better. Since `item.id` is the deterministic
`itemPrimaryKey(service, externalId)`, keying on `item_id` makes `(service, pr_external_id)`
redundant — so **both tables are now keyed on `item_id`** with a cascade to `item`, matching
`deployment-v28-sql.ts`'s established shape.

The spec records the non-obvious half: the cascade on `pr_files_state` matters in the *opposite*
direction from storage hygiene. A coverage row surviving its PR would assert "we know this PR's
files" after the file rows were cascaded away — claiming verification the index no longer holds,
which is § 2's failure mode arriving through the back door.

---

## 1.3 — canonical SQL: the right idea, and its example carried a silent bug

Shipping a canonical shape is worth doing, and B now ships it as a store helper (§ 4.4) rather than
leaving W6-B to reconstruct it. The structural point in the suggested template is right and is
preserved: the **inner join to the coverage table** is what makes fail-closed mechanical — a
`LEFT JOIN`, or reading `pr_changed_file` alone, silently restores the false positive.

**But the template used `LIKE 'tests/%'`, and `LIKE` is the wrong operator for paths — in two ways,
both silent.** Verified empirically against this repo's `bun:sqlite` rather than asserted:

| Expression | Result |
| --- | --- |
| `'Tests/a.ts' LIKE 'tests/%'` | **1** — LIKE is case-insensitive for ASCII |
| `'Tests/a.ts' GLOB 'tests/*'` | `0` |
| `'src/myXfile.ts' LIKE 'src/my_file.ts'` | **1** — `_` is a LIKE wildcard |
| `'src/myXfile.ts' GLOB 'src/my_file.ts'` | `0` |

Paths are case-sensitive on Linux and macOS, so `LIKE` answers a `tests/` question using `Tests/`
data. And `_` is common in real filenames, so any user-supplied pattern containing one silently
becomes a wildcard — in a predicate language whose entire purpose is precise negation, that is a
correctness bug users would never diagnose. The spec specifies `GLOB`, as a bound parameter.

Two smaller corrections: the table is `item`, not `items`, and the join is now on `item_id` per
1.2.

---

## 2.1 — batch inserts: accepted, with the transaction boundary made explicit

Correct, and the reasoning holds: a capped PR contributes up to `MAX_FILES_PER_PR` rows and a tick
covers several PRs, so per-row transaction overhead would be paid thousands of times per sync.

The spec adds the part the suggestion did not specify, which is the part that matters for
correctness rather than speed: **transaction scope is per PR, and it must enclose the
`pr_files_state` row together with the file rows it describes.** A crash between the two would
leave a PR marked covered with a partial list — § 2's failure mode produced by our own write path
rather than by the forge. Writes go through `dbStmtRun` / `dbExec` per I14, and the prepared
statement is finalized (an unfinalized `prepare()` makes `close()` a silent no-op in `bun:sqlite`).

---

## 2.2 — page size: accepted

Concrete and correct. GitHub's files endpoint defaults to 30 per page and accepts `per_page=100`,
so the default costs 3.3× the requests for any PR touching more than 30 files — which describes
most PRs anyone would ask a negation about. Each forge's page-size parameter is now set explicitly
and sized against `MAX_FILES_PER_PR`, so the cap is reached in the fewest requests rather than
incidentally.

The exact page-size parameter for each forge is verified alongside the response-shape fixtures
(§ 10.1), not taken from memory.
