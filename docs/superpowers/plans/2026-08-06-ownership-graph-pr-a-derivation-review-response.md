# Response to the PR A plan review

Responds to [`2026-08-06-ownership-graph-pr-a-derivation-review.md`](./2026-08-06-ownership-graph-pr-a-derivation-review.md);
amendments land in [`2026-08-06-ownership-graph-pr-a-derivation.md`](./2026-08-06-ownership-graph-pr-a-derivation.md)
and, for the reaping rationale, in the design spec.

**Verdict: 3 fixed, 1 answered — no deferrals.** Every claim was checked against source at
`origin/main` = `826b76a1`, and one was checked by running a probe.

| # | Item | Outcome |
| --- | --- | --- |
| 1 | Compile globs outside the loop | **Fixed, and extended** — the bigger win was one the review missed |
| 2 | Bulk clear + reap instead of per-id loops | **Fixed, with the `NOT IN` → `NOT EXISTS` correction** |
| 3 | Parallel git remote spawning | **Fixed** — accepted for a different, stronger reason; magnitude claim corrected |
| 4 | Crash safety of `simpleStep` | **Answered: yes, atomic** — verified, no change needed |

---

## 1. Compiling globs outside the loop — FIXED, AND EXTENDED

**Correct.** `new Bun.Glob(g)` was being constructed inside the per-row loop.

**The review under-counted the problem, and its fix only addresses half of it.** The rows
returned by `aggregateBlameForRoot` are blame **lines**, not files. Hoisting compilation removes
`lines × patterns` *allocations*, but leaves `lines × patterns` *match calls* — and matching, not
construction, is the dominant cost. A 5,000-line file is still matched 5,000 times against all
21 default patterns for a decision that depends only on the path.

**Implemented:** compile once **and** memoize the decision per file path.

```ts
const compiled = compileIgnoreGlobs(opts.ignoreGlobs);
const ignoredByPath = new Map<string, boolean>();
const isIgnored = (path: string): boolean => { /* memo lookup, else match + store */ };
```

On a 50k-line root spanning 400 files, this goes from ~1.05M match calls to ~8.4k — two orders
of magnitude, versus the ~1x match-count reduction the review's version would achieve.

**API shape:** `compileIgnoreGlobs` and `matchesAnyCompiledGlob` are now the primitives, and the
existing `isIgnoredPath(path, globs)` is retained as a string convenience composing them, so the
tests written against it stay valid and unchanged. Its doc comment states it compiles per call
and is not for hot loops. Two tests were added: the compiled pair must agree with the
convenience wrapper on every input, and compiling `[]` must yield a matcher that matches nothing.

## 2. Bulk clear + reap — FIXED, with a correction to the proposed SQL

**Correct.** `clearOwnershipEdgesFor` and `reapOrphans` each ran per-candidate queries in a loop;
on a repo with thousands of files that is thousands of statement executions per pass.

**Adopted, with one change.** The review's reap SQL uses:

```sql
AND id NOT IN (SELECT from_id FROM graph_relation)
AND id NOT IN (SELECT to_id   FROM graph_relation)
```

`NOT IN` against a subquery is the classic SQL footgun: if the subquery yields a single NULL,
the predicate is never true for any row and the statement silently deletes **nothing** — which
would look exactly like the feature working. Here it happens to be safe, because
`from_id`/`to_id` are `TEXT NOT NULL` (`index/graph-v7-sql.ts:19-20`) — I verified that rather
than assuming it. But the correctness of the delete should not rest on a constraint declared in
a different file that a future migration could relax, so both clauses are `NOT EXISTS`, which is
immune and uses the existing `idx_graph_relation_from` / `idx_graph_relation_to` indexes.

**The scoping change is an improvement on my own design, and I've amended the spec.** My plan
pre-collected an explicit candidate id set specifically to avoid a `LIKE 'file:<root>:%'` prefix
delete, since a `repoRoot` containing `%` or `_` would silently widen it. The review's
`service = ?1` is an **exact equality on a dedicated marker column**, which carries none of that
hazard *and* is a single statement — strictly better than materializing ids first. The spec's
"Orphan reaping" section now states the rule as scoped-by-exact-equality rather than
explicit-candidate-set, and records why `NOT EXISTS` over `NOT IN`.

**`changes` for the stat:** verified available. `dbRun` returns bun's run result, and a probe
gives `{"changes":2,"lastInsertRowid":2}`; the codebase already relies on it
(`automation/extension-store.ts:54`, `connectors/health.ts:319`). `entitiesReaped` now comes
from `res.changes`.

**The load-bearing reaping test is unchanged and still governs:** a `source_file` still carrying
a `defined_in` edge from `syncCodeSymbolGraph` must survive with that edge intact. The
red-prove step was rewritten against the new function so it still breaks the right thing.

## 3. Parallel git remote spawning — FIXED, for a better reason

**Adopted**, but the stated justification does not hold and the real one is stronger.

**Magnitude claim corrected.** "Sequential spawning of 20 subprocesses will block the pass for
several seconds" overstates it: `git remote` and `git remote get-url` are metadata reads costing
roughly 20–40 ms each, so ten roots is ~0.3–0.8 s, inside a pass that is already debounced 30 s
and runs in the background. That alone would not justify the change.

**The real reason is structural.** Awaiting a subprocess *inside* the per-root loop interleaves
process I/O with SQLite writes. Hoisting all remote resolution into a `Promise.all` prefetch
before the loop leaves that loop as uninterrupted synchronous database work — which is what makes
it possible to wrap the loop in a transaction later. An `await` in the middle of a
`db.transaction()` body is how long-held write locks and half-applied passes get introduced.
The plan now records that as the motivation, so a future reader does not "optimize" it back.

Parallelism is unbounded across roots, which is fine at realistic root counts (1–5, occasionally
low tens) for two short-lived metadata reads each. If root counts ever reach the hundreds this
needs a concurrency cap — noted, not built, because building it now would be speculative.

## 4. Crash safety of `simpleStep` — ANSWERED, no change

**Yes, atomic — verified, not assumed.** `applySchemaStep` (`index/migrations/runner.ts:122`)
wraps all three effects in one transaction:

```ts
db.transaction(() => {
  /* each SQL statement in order */
  dbExec(db, `PRAGMA user_version = ${String(version)}`);
  recordMigration(db, version, description, now);
})();
```

So the interleaving the question raises — relation types inserted but `ownership_pass_state` not
created — cannot be observed. A crash mid-step rolls back every statement *plus* the
`user_version` bump and the ledger row, so the next startup re-runs the step from 50 rather than
finding a half-applied 51. `PRAGMA user_version` is stored in the database header and is itself
transactional in SQLite, which is what makes the version and the schema unable to disagree.

The `INSERT OR IGNORE` / `CREATE TABLE IF NOT EXISTS` idempotence the question notes is a second,
independent layer: it makes the step safe to re-run even if the transactional guarantee were
somehow absent. Belt and braces, and the plan already tests re-running the migration on an
already-migrated database.

---

## Net effect

All amendments are confined to Tasks 3 and 6 of the plan, plus the spec's "Orphan reaping"
rationale. No new files, no new tasks, no schema change — still **V51**. Test count rises from
56 to 58. Nothing touches IPC, CLI, Tauri, `security-invariants.test.ts`, or
`packages/gateway/src/graph/`.
