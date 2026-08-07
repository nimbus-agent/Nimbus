# Response to the ownership-graph design review

Responds to [`2026-08-06-ownership-graph-design-review.md`](./2026-08-06-ownership-graph-design-review.md);
amendments land in [`2026-08-06-ownership-graph-design.md`](./2026-08-06-ownership-graph-design.md).

**Verdict: 3 fixed, 1 fixed with the premise corrected, 1 deferred with reasoning.** Every claim
was checked against source at `origin/main` = `826b76a1` before being accepted or rejected.

| # | Item | Outcome |
| --- | --- | --- |
| 1 | Vendor / lock-file / generated-file exclusion | **Fixed** — §5.5.1, config key, pass-state counter, tests |
| 2 | Tie-breaking with mixed person id formats | **Fixed as clarification; premise corrected** — §5.5 |
| 3a | Caching git remote resolution | **Deferred** with a stated revisit trigger — §5.7 |
| 3b | Remote fallback when `origin` is absent | **Fixed, in a bounded form** — §5.7 |
| 4 | Graph cleanup for deleted/moved paths | **Fixed** — §6 "Orphan reaping" |

---

## 1. Vendor / lock-file / generated-file exclusion — FIXED

**The concern is real, and stronger than the review states.** I verified the enumeration:
`gitBlameWindowFiles` (`connectors/blame-index-sync.ts:70`) is

```sh
git log --since=<N> days ago --name-only --pretty=format: -z
```

with **no filtering of any kind**. It does not consult a filesystem root's `exclude` list, so
the review's hedge ("filesystem roots may exclude `node_modules`") does not apply — nothing is
excluded from `git_blame_line`. A churning `package-lock.json` is thousands of lines attributed
to whoever last ran the installer, and under weighted-total rollup (which is correct, and which
the review rightly praised) that lock file would dominate its entire directory.

**Fix:** an `ignore_globs` config key, matched with `Bun.Glob` at **aggregation** time. Defaults
cover lock files across nine ecosystems, `vendor/`, `node_modules/`, `dist/`, `build/`,
minified assets, snapshots, and common generated suffixes.

Three design points the review did not raise but that determine whether the fix is correct:

- **Filter at aggregation, not at blame indexing.** `git_blame_line` is shared with `nimbus why`'s
  provenance lanes, which legitimately need to answer "who last touched this lock-file line".
  Narrowing what gets blamed would silently degrade a shipped, unrelated feature.
- **Exclude from numerator *and* denominator.** Removing a path from only the numerator would
  leave a file whose lines are all ignored reporting a degenerate 100% owner.
- **`Bun.Glob`, not hand-rolled regex.** Compiling a user-supplied pattern into a backtracking
  regex is a ReDoS surface, and glob-to-regex translation is precisely where that defect is
  usually introduced.

`ownership_pass_state.files_excluded` records the count so the filter is auditable rather than
invisible, and §7's limit 5 now says the mitigation is partial rather than implying it is total.

## 2. Tie-breaking with mixed person id formats — FIXED (premise corrected)

**The stated premise does not hold.** The review contrasts "DB integer/UUID `person` IDs" with
string `git:<email>` ids. There are no integer or UUID person ids in this codebase:
`person.id` is `TEXT PRIMARY KEY` (`index/unified-item-v3-sql.ts:3`). Both key kinds are already
`TEXT`, so the mixed-format sort hazard as described cannot occur.

**The suggestion is still worth taking**, because my wording was loose in a way that invited the
question. "Ties are broken by person id ascending" now reads "by the **graph entity external
id** ascending", which is what the implementation must actually sort on and which stays correct
if person ids ever change shape.

Recording the correction rather than quietly adopting the wording matters: had I implemented
against the review's premise, I might have introduced a cast or a normalization step guarding
against a heterogeneity that does not exist.

## 3a. Caching git remote resolution — DEFERRED

**Cost is one `git remote get-url` spawn per root per debounced pass** (default 30s), against
roots the blame sync is already spawning `git blame` against up to 400 times per tick
(`MAX_BLAME_FILES = 400`). Remote resolution is noise inside that budget.

**What a cache would buy and what it would cost.** It saves a few milliseconds. It adds an
invalidation rule and a staleness failure mode: a user who repoints a remote keeps a service
bound to the wrong repository until something evicts the entry — a silent wrong answer, which
is a strictly worse class of bug than the latency it removes. The review's proposed trigger
("only re-query if a filesystem workspace sync detects a change") does not cover the case that
matters, because changing a git remote touches no indexed file and so produces no such signal.

**Revisit trigger, now recorded in §5.7:** if `ownership_pass_state.last_duration_ms` shows
remote resolution to be material. Optimizing it before then is unmeasured.

## 3b. Remote fallback when `origin` is absent — FIXED, BOUNDED

**Adopted, but not as "the first available remote."** In a fork workflow `origin` is the user's
fork and `upstream` is canonical. Picking the first remote when several exist binds a service to
whichever the enumeration happened to return, and does so silently — the wrong-answer class
again.

**Implemented rule:** fall back to the sole remote **iff exactly one exists**. With two or more
non-`origin` remotes, emit no `tracks_remote` edge and log the ambiguity. This recovers the
common single-remote case the review correctly identified, while failing closed on the ambiguous
one and making it observable — the same posture as `AmbiguousBindingWarning`
(`metrics/service-identity.ts:38`), which reports a contested binding instead of letting a
tie-break disappear.

## 4. Graph cleanup for deleted/moved paths — FIXED

**The strongest item in the review, and a genuine gap in the spec.** The answer to the question
as asked was: relations only. Nothing else would have collected the entities —
`deleteGraphEntitiesForItemKeys` (`graph/relationship-graph.ts:120`) deletes only
`ITEM_LINKED_ENTITY_TYPES`, a list containing neither `source_file` nor `directory`. The graph
would have accumulated a shadow tree of paths that no longer exist, growing with every refactor.

**Fix:** a reaping step, under two conditions that are what make it safe rather than dangerous:

1. **Explicit candidate set, never a path pattern.** The pass records which entity ids held
   `owns` / `contains` edges before clearing, and after re-emitting deletes those now at
   degree 0. It does not issue a `LIKE 'file:<root>:%'` delete — a `repoRoot` containing `%` or
   `_` would silently widen that pattern across roots.
2. **Degree 0 across *all* relation types.** A `source_file` may still carry `defined_in` edges
   from `syncCodeSymbolGraph`, which owns them; `graph_relation` cascades on entity deletion, so
   reaping an entity that still has any edge would destroy another populator's work. Both
   populators converge on the same `source_file` external-id form deliberately, and the
   zero-degree test is what makes that convergence safe from either side.

A degree-0 entity has no relations to cascade, so the delete is inert beyond the row itself.

**Tests added**, including the two that would catch a wrong implementation: a `source_file`
holding a `defined_in` edge must survive reaping with that edge intact (red-proven by weakening
the degree-0 test to degree-0-in-`owns`/`contains` and watching the code-symbol edge vanish), and
a second root whose path contains `%` and `_` must be untouched by the first root's reap.

---

## Net effect on delivery

The four adopted amendments (1, 2, 3b, 4) land in **PR A**; item **3a is deferred**, with the
revisit trigger stated in §5.7 — it is not part of this delivery. None touches IPC, CLI, Tauri, or
`security-invariants.test.ts`, so the parallel-isolation property the review credited is
preserved. Schema stays **V51** — `files_excluded` and `entities_reaped` are two more columns on
the not-yet-created `ownership_pass_state` table, not a second migration.
