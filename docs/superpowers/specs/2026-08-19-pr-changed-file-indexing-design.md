# PR changed-file indexing — design

**Date:** 2026-08-19
**Status:** Design approved, not yet implemented.
**Relationship to other work:** sub-project **B** of the changed-file-indexing effort, built on
sub-project **A** (graph-entity metadata namespacing, shipped 2026-08-19 as #1255 / V54). B is the
data prerequisite for **W6-B first-class negation queries**, the last open Wave 6 row. B ships no
predicate language; see § 8.

---

## 1. What this is

A PR's changed-file **paths** are not indexed anywhere. `connectors/github-sync.ts` stores
`changed_files` as a **count** — one of four size stats hydrated from the pull-detail endpoint —
and nothing stores which files those were.

So the canonical W6-B example, *"PRs that don't touch tests"*, is not partially answerable today.
It is not answerable at all.

This spec indexes the paths, for GitHub, GitLab and Bitbucket, behind a coverage record that makes
"we do not know" distinguishable from "we checked and it does not match".

---

## 2. Why negation makes partial data dangerous rather than merely incomplete

This is the constraint the whole design is shaped around, and it does not apply to ordinary
queries.

For a positive query — *"PRs that touch `src/auth/`"* — a missing row costs a result. The answer is
short, and a gap note describes the shortfall honestly.

For a negation — *"PRs that **don't** touch `src/auth/`"* — a missing row **produces** a result. A
PR whose file list was never fetched matches "no row with that path" exactly as well as a PR that
genuinely did not touch it. The two are indistinguishable at the SQL level, and the un-indexed PR
is returned as a confident answer.

So partial coverage does not make a negation incomplete. It makes it **wrong**, silently, in the
direction of a confident false positive — and the more incomplete the index, the *more* results it
returns, which is the opposite of the signal a reader expects.

Everything below follows from that: coverage is recorded explicitly, and anything not positively
verified is excluded rather than assumed.

---

## 3. Decisions taken (recorded so they are not relitigated)

**D1 — coverage is configured repos, forward plus a bounded backfill.** Not every indexed PR: a
full backfill is one API call per PR minimum, so a 5,000-PR index consumes roughly a full hour of
GitHub's authenticated rate limit before any sync work happens. Not on-demand at query time
either: that turns a local read into a network round-trip per candidate and makes query latency
unbounded, which breaks the local-first read path. A configured, bounded set is the only option
where "which PRs are covered" has a nameable answer — and § 2 means that answer is load-bearing,
not cosmetic.

**D2 — an uncovered PR is EXCLUDED from negation, and counted in a gap.** Fail-closed. A PR with
no indexed file list can never satisfy "does not touch X"; it is dropped, and the caller is told
`N PRs excluded: no indexed file list`. Every returned row is positively verified. The rejected
alternative — include it and add a prose caveat — is precisely the false-positive generator of
§ 2, with a warning line that is easy to miss and impossible to act on.

**D3 — all three forges, one storage and query path.** GitHub, GitLab and Bitbucket all index PRs
as `type: "pr"` items carrying a `service` column and a `<repoFull><sep><num>` external id (`#` on
GitHub and Bitbucket, `!` for GitLab MRs). Only the fetch and the response mapping differ per
forge; storage, coverage and reads are written once. This is why three forges is three endpoints
and three fixture sets rather than three subsystems.

**D4 — a dedicated table, not graph relations and not `item.metadata`.**
Graph relations (`pr --touches--> source_file`) were rejected on three counts: `graph_relation`
carries no attributes, so `status` has nowhere to live; every remote path would need a
`source_file` entity even where no local file exists; and — decisively — the **absence of an edge
is ambiguous**, unable to express "not fetched" versus "fetched, did not touch", which is the one
distinction § 2 makes load-bearing. It would also add a third writer to the metadata sub-project A
has just finished namespacing.
`item.metadata` was rejected because `upsertIndexedItem` writes `metadata = excluded.metadata`,
replacing the column wholesale — the identical clobber class A exists to fix — and because an
unindexed JSON array turns negation into a full scan.

**D5 — B ships no query surface.** Observability is a coverage line on the existing
`diag.snapshot` payload, surfaced by `nimbus status`. No new IPC method, no Tauri allowlist change
(`ALLOWED_METHODS` stays at 105), no new CLI command. See § 8.

---

## 4. Schema (V55)

### 4.1 `pr_changed_file`

```sql
CREATE TABLE pr_changed_file (
  item_id          TEXT NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  repo_full        TEXT NOT NULL,
  path             TEXT NOT NULL,
  status           TEXT NOT NULL,
  counterpart_path TEXT,
  local_file_id    TEXT REFERENCES graph_entity(id) ON DELETE SET NULL,
  PRIMARY KEY (item_id, path)
) WITHOUT ROWID;

CREATE INDEX idx_pr_changed_file_path ON pr_changed_file(path);
CREATE INDEX idx_pr_changed_file_local ON pr_changed_file(local_file_id);
```

**Keyed on `item_id`, not `(service, pr_external_id)`.** The PR's `item.id` is already the
deterministic `itemPrimaryKey(service, externalId)`, so the pair is redundant, and keying on the
item id buys automatic cleanup: prune or re-sync a PR and its file rows and coverage row go with
it. This follows the repo's established shape — `index/deployment-v28-sql.ts` makes the item id its
own primary key with `REFERENCES item(id) ON DELETE CASCADE`, and `embedding-v6-sql.ts` does the
same on a child table.

**Foreign keys here are enforced, not decorative:** `index/local-index.ts` runs
`PRAGMA foreign_keys = ON`, as do `db/repair.ts`, `db/verify.ts` and the embedding worker. A
cascade written here actually fires, which is why the pruning story below is mechanical rather than
a documented intention.

**One row per touched path is the load-bearing invariant.** A single index on `path` then answers
negation with no special cases, and two things that would otherwise be silent bugs become
structural:

- **A deletion is a touch.** A PR that deletes `tests/foo.ts` must not answer "does not touch
  `tests/`". Status is recorded, but membership — not status — decides the predicate.
- **A rename touches BOTH paths.** `tests/a.ts → src/a.ts` emits two rows, so the PR correctly
  fails a "does not touch `tests/`" filter. The rejected alternative — one row on the new path with
  a `previous_path` column — requires every query to check two columns, and the first query that
  forgot one would be wrong rather than slow. `counterpart_path` records the pairing for display;
  nothing correctness-bearing reads it.

`status` is stored as the forge reported it, normalised to a small set
(`added` / `modified` / `removed` / `renamed`). It is descriptive. No predicate depends on it.

### 4.2 `pr_files_state` — the coverage record

```sql
CREATE TABLE pr_files_state (
  item_id        TEXT PRIMARY KEY REFERENCES item(id) ON DELETE CASCADE,
  fetched_at_ms  INTEGER NOT NULL,
  api_file_count INTEGER NOT NULL,
  stored_count   INTEGER NOT NULL,
  truncated      INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
```

The cascade matters more here than on `pr_changed_file`, and in the opposite direction from
storage hygiene: if a PR item is pruned and later re-synced, its coverage row must NOT survive.
A stale coverage row would assert "we know this PR's files" about a PR whose rows were cascaded
away — claiming verification the index no longer holds, which is the § 2 failure mode arriving
through the back door. Cascading both tables from the same parent keeps them consistent by
construction rather than by a cleanup routine that could lag.

This table is what makes D2 mechanical rather than aspirational: the fail-closed exclusion is a
**join against a coverage row**, not an inference from empty results.

**`truncated` is excluded exactly like unfetched.** A PR of 4,000 files capped at 300 is not safely
negatable — "does not touch X" is unverifiable while we hold 300 of 4,000 paths. Counting a
truncated PR as covered would make the cap a second, quieter false-positive source, defeating D2 by
a side door. `api_file_count` versus `stored_count` records the shortfall rather than merely
flagging it.

### 4.3 `local_file_id` — derived, never authoritative

The remote path is the source of truth and is always present. `local_file_id` holds the
`graph_entity.id` of the corresponding `file:<root>:<path>` entity when one can be resolved, and
`NULL` otherwise.

Resolution uses the bridge that already exists: `workspace --tracks_remote--> repo`, written by
`ownership/ownership-pass.ts` and already queried in `ownership/ownership-store.ts`. The `repo`
entity is keyed `<service>:<owner>/<name>` by both the local ownership pass and the remote PR
sync, so the join is real rather than a guess.

It is **refreshable, not once-only**: cloning a repo months after its PRs were indexed must be able
to backfill the column. Nothing about negation depends on it — it exists so PR-touch data can join
to ownership and symbol data when a local clone exists.

**Deletion is handled by the schema, not by prose.** `local_file_id` is declared
`REFERENCES graph_entity(id) ON DELETE SET NULL`, so when a file entity disappears the column
returns to `NULL` on its own. This is not hypothetical: `ownership/ownership-pass.ts`'s
`reapOrphansForRoot` deletes degree-0 `source_file` and `directory` entities, so untracking a
workspace really does remove the rows this column points at. `SET NULL` makes that self-healing and
returns the row to exactly the state it has for a repo that was never cloned — the same state the
rest of this section already describes. An instruction to "nullify dangling references" would have
been a rule someone must remember; this is one the database enforces.

**Population is DEFERRED — this sub-project ships the column UNPOPULATED.** The schema, the
`ON DELETE SET NULL` behaviour and the index all ship; no code writes the column, so it is `NULL`
on every row. That is deliberate rather than unfinished: nothing in this sub-project reads
`local_file_id` — negation is answered from `path` alone (§ 4.4) — so a writer would serve no
consumer today, and the design intent below records who should own it when a consumer exists.
Read the rest of this section as the eventual contract, not as shipped behaviour.

**The ownership pass is the intended owner of the re-population**, not a standalone step. It is
already the code that discovers a root, resolves its remote, and writes the `tracks_remote` edge
this resolution reads — so it is the first code in the system that *knows* a
previously-unresolvable repo has become resolvable.
A standalone step would have to re-derive that same signal and would run on its own
schedule, meaning the column could sit stale for a full cycle after the clone appeared. The cost of
that choice, stated in advance: `pr_changed_file` rows would then be written by the sync path and
updated by the ownership path, so the column would have two writers. That is safe because they
would write **disjoint columns** — the sync path never writes `local_file_id`, and the ownership
pass would write nothing else — but it is the same shape as the bug sub-project A just fixed, so it
is called out rather than left for a reader to discover. Until that work lands the column has ONE
writer (the schema default) and no reader.

### 4.4 The canonical negation shape

B ships this as a store helper rather than leaving W6-B to reconstruct it, because two of its
three properties are easy to get wrong and wrong in the silent direction.

```sql
SELECT i.*
FROM item i
JOIN pr_files_state s ON s.item_id = i.id      -- coverage: no row => excluded
WHERE i.type = 'pr'
  AND s.truncated = 0                          -- a partial list cannot verify a negative
  AND NOT EXISTS (
        SELECT 1 FROM pr_changed_file f
        WHERE f.item_id = i.id
          AND f.path GLOB ?1                   -- GLOB, never LIKE
      );
```

**Fail-closed by two independent mechanisms.** *(Corrected during implementation — this section
originally claimed a `LEFT JOIN` alone would restore the bug. Measured against `bun:sqlite`, it
does not.)*

1. The inner `JOIN` to the coverage table: an uncovered PR has no row to join to.
2. `s.truncated = 0`: on an uncovered PR that column is `NULL`, and `NULL = 0` evaluates to `NULL`,
   which `WHERE` treats as not-true — so the row drops here as well.

| Query shape | Uncovered PR returned? |
| --- | --- |
| `JOIN` + `truncated = 0` | no |
| `LEFT JOIN` + `truncated = 0` | no — the NULL comparison still excludes it |
| `LEFT JOIN` + `COALESCE(truncated, 0) = 0` | **yes — the bug** |
| no coverage join at all | **yes — the bug** |

Either mechanism alone is sufficient, which makes the guard sturdier than first specified but also
means **no single-line edit demonstrates its necessity**. The regression to guard against is the
combined one: a `LEFT JOIN` plus a null-softened comparison — precisely the shape a well-meaning
"null-safety" cleanup produces — or dropping the coverage table from the query altogether.

**`GLOB`, not `LIKE`** — verified empirically against this repo's `bun:sqlite`, because both
failure modes are silent:

| Expression | Result |
| --- | --- |
| `'Tests/a.ts' LIKE 'tests/%'` | **1** — LIKE is case-insensitive for ASCII |
| `'Tests/a.ts' GLOB 'tests/*'` | `0` — GLOB is case-sensitive |
| `'src/myXfile.ts' LIKE 'src/my_file.ts'` | **1** — `_` is a LIKE wildcard |
| `'src/myXfile.ts' GLOB 'src/my_file.ts'` | `0` — `_` is literal under GLOB |

Paths are case-sensitive on Linux and macOS, so `LIKE` would answer a `tests/` question using
`Tests/` data. Worse, `_` is extremely common in real filenames, so any user-supplied pattern
containing one silently becomes a wildcard under `LIKE`. `GLOB` is the correct operator for path
matching on both counts, and the pattern is a bound parameter — never interpolated (I9/I14).

---

## 5. The fetch path

A per-forge sibling of the existing `enrichPrDetail`, which is the pattern to copy in full: a
bounded-per-tick backlog drain inside the scheduled sync run, using `ctx.rateLimiter.acquire()`,
reached on **both** the changed and the 304 paths so a quiet tick still makes progress. That last
detail is not incidental — `enrichPrDetail`'s own docstring records that before it was shared
across both paths, the backlog drained at roughly zero on a low-activity account.

**One selector serves forward coverage and backfill together.** A `modified_at DESC`, per-tick-
capped candidate query drains newest-first, so recent PRs are covered first and the backlog shrinks
every tick. There is no separate backfill mode to build, configure, or explain.

Per forge, only the request and the response mapping differ:

| Forge | Endpoint | Rename signal |
| --- | --- | --- |
| GitHub | `pulls/{n}/files` | `status: renamed` + `previous_filename` |
| GitLab | MR diffs | `old_path` / `new_path` + `renamed_file` |
| Bitbucket | PR `diffstat` | `old` / `new` + `status` |

**These response shapes are stated from prior knowledge, not read from this tree.** They are
external API contracts. The implementation plan MUST verify each against a recorded fixture before
its mapping is written, the way every other connector here is tested — a mapping written from
memory is exactly how a silently-wrong `status` or a missed rename field would ship.

### 5.1 Caps, each with a stated consequence

- `MAX_PRS_PER_TICK` — bounds rate-limit burn per sync run.
- `MAX_PAGES_PER_PR` / `MAX_FILES_PER_PR` — a PR exceeding the cap is stored **and marked
  `truncated`**, therefore excluded from negation per § 4.2.
- The existing per-service rate limiter is reused, not reinvented.

**Request the largest page the forge allows.** GitHub's files endpoint defaults to 30 per page and
accepts `per_page=100`, so the default costs 3.3× the calls for any PR touching more than 30
files — which is most PRs worth asking a negation about. Each forge's page-size parameter is set
explicitly and sized against `MAX_FILES_PER_PR`, so the cap is reached in the fewest requests
rather than incidentally.

### 5.3 Writes are batched, in one transaction per PR

A capped PR can contribute up to `MAX_FILES_PER_PR` rows, and a tick covers several PRs, so
single-row inserts would pay SQLite's per-statement transaction overhead thousands of times per
sync. Each PR's rows are written with one prepared statement reused across its paths, inside a
single transaction that also writes that PR's `pr_files_state` row.

Transaction scope is per PR, deliberately: the coverage row and the file rows it describes must
land together. A crash between them would leave a PR marked covered with a partial file list —
§ 2's failure mode again, produced by our own write path rather than by the forge. The write goes
through `dbStmtRun` / `dbExec` per I14, and the statement is finalized rather than left open.

### 5.2 Cost, stated plainly

This roughly **doubles API calls per PR** on the enrich path — detail, then files. It runs
**unconditionally for configured repos, with no config knob to disable it**, matching how
PR-detail enrichment already behaves. A large index takes many ticks to reach full coverage; the
coverage table is what makes that progress visible instead of mysterious.

Unconditional is defensible because the pass is already bounded on both axes: at most
`MAX_PRS_PER_TICK` (10) PRs are recorded per tick, at most `MAX_PAGES_PER_PR` (3) requests each,
and it yields the moment the provider is penalised or its token bucket is empty — it calls
`rateLimiter.tryAcquire`, which never sleeps, so a rate-limited provider ends the pass for that
tick rather than blocking a scheduler slot.

**Named follow-up: a `[connectors.pr_files] enabled` knob.** Deliberately not built here — a
config surface needs its own field, default, wiring, docs and tests, which is a wider change than
this sub-project. The cost of deferring, stated: a user on a tight API budget cannot turn the pass
off without a follow-up PR.

---

## 6. Egress

**No new egress class, and no invariant change.** The fetch runs inside the scheduled sync run,
where `egress/sync-egress.ts`'s `recordSyncEgress` already appends one row per run (I29's `sync`
coverage class is `per-run`). B adds HTTP calls at exactly the same granularity the existing
PR-detail fetch already has. Nothing about I29's documented coverage changes, and the spec claims
no improvement to it.

---

## 7. Observability

`diag.snapshot`'s existing `index` section gains a PR-file coverage summary, printed by
`nimbus status` alongside the `Embedding backfill: <done> / <total>` line it already prints —
the direct precedent for reporting backlog progress this way.

```text
PR file coverage: 412 / 1203 (18 truncated)
```

Extending an existing payload means no new IPC method, no Tauri allowlist change, and no new CLI
command.

---

## 8. Scope boundary — what B does NOT do

B ships **no predicate language**: no `--negate`, no `--touches`, no `--explain`. Those are W6-B.

Building even a thin slice here would start the predicate surface in a spec that did not scope it,
leaving W6-B to extend or redesign someone else's half-decision. B delivers the data and the
fail-closed primitive; W6-B builds the language on top and owns its own review.

Concretely, B delivers: the two V55 tables, three forge fetch paths, a store module exposing reads
plus coverage, the exclusion logic W6-B will call, and the `nimbus status` coverage line.

Also out of scope: PR **diff content** (only paths and status are stored), and any predicate over
`status` — see § 4.1.

---

## 9. Testing

- **Fixture-driven mapping tests per forge**, from recorded real payloads (§ 5), each asserting the
  one-row-per-touched-path invariant — including a rename producing two rows and a deletion
  producing one.
- **A negation-correctness test that would fail under the rejected design**: a PR with no coverage
  row must NOT be returned by "does not touch X". Red-prove it by removing the coverage join and
  confirming the test goes red — otherwise the fail-closed claim rests on nothing.
- **A truncation test**: a PR marked `truncated` is excluded on the same footing as an unfetched
  one.
- **A migration test** covering a fresh database and a re-run (idempotence), per the repo's
  migration contract.
- Coverage floor: every touched file ≥85% line and ≥80% branch.

---

## 10. Open questions carried into the plan

Both remaining items are lookups the plan performs against the tree or a fixture. Neither is an
unresolved design decision — every decision in this spec is made, in § 3 and § 4.

1. The three response shapes in § 5 need fixture verification before their mappings are written.
   The spec states them from prior knowledge and says so; the plan replaces knowledge with a
   recorded payload.
2. Cap values (`MAX_PRS_PER_TICK`, `MAX_FILES_PER_PR`, `MAX_PAGES_PER_PR`) are named but not yet
   numbered. The plan picks them against the existing `MAX_ENRICH_PER_TICK` and each forge's
   documented page size, and records the rate-limit arithmetic behind each.

**Verified against the tree while writing this spec, not assumed:** `ALLOWED_METHODS.len()` is
asserted as `105` in `packages/ui/src-tauri/src/gateway_bridge.rs`, so § 3's D5 claim holds.
(`docs/roadmap.md` prose says `nimbus negotiate` moved it `105 → 106`; the tree disagrees. Noted
here because it was checked, not fixed — it is outside B's scope.)
