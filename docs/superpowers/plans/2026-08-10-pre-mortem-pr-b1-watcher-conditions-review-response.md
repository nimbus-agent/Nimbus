# pre-mortem PR B1 — Response to Plan Review

Responds to [`2026-08-10-pre-mortem-pr-b1-watcher-conditions-review.md`](./2026-08-10-pre-mortem-pr-b1-watcher-conditions-review.md).

**One finding was a genuine bug and is fixed. One question surfaced a different, real defect in the
plan — also fixed. One suggestion is accepted as a comment. Two are already verified true and need no
change.**

---

## S1 — `json_extract` on invalid/NULL metadata · **ACCEPTED — this was a real bug**

The review is right, and the failure is worse than "the query fails". Verified empirically against
`bun:sqlite` (SQLite 3.53.0) rather than reasoned about:

| `metadata` value | `json_extract(metadata, '$.conclusion') = 'failure'` |
|---|---|
| `{"conclusion":"failure"}` | matches |
| `NULL` | safe — yields NULL, no match, no error |
| `'not json at all'` | **raises `malformed JSON`** |
| `''` (empty string) | **raises `malformed JSON`** |

The predicate runs inside `evaluateOneWatcher`, which is called in a loop over
`listEnabledWatchers` from `evaluateWatchersAfterSync`, and **nothing in that path catches**. So one
bad row would abort evaluation for **every watcher on the machine**, not merely the deploy one — a
data-dependent, silent-until-it-happens failure introduced by a feature that is supposed to make
watchers more reliable.

**Fix.** `deploy_failed`'s predicate becomes:

```sql
AND json_valid(metadata) AND json_extract(metadata, '$.conclusion') = 'failure'
```

Verified: the guarded form returns the one matching row across all four cases above without raising.

**Can such a row exist today?** No. Both production writers of `item.metadata` — `index/item-store.ts`
and `deployment/annotate.ts` — go through `JSON.stringify`. The guard therefore protects against a
migration or a future writer, not a present bug. It is still worth it: the cost is one cheap SQL
function, and the blast radius of being wrong is the entire watcher subsystem.

**Two additions beyond the one-line fix**, so the guard cannot be quietly dropped later:

- A regression test that force-corrupts one row's metadata via raw SQL and asserts a *different*,
  valid failed deployment still fires. (`db.run` in a test file is established practice here and is
  not scanned by the D12/I14 static audit — many `packages/gateway/src/agents/*.test.ts` do it.)
- The table-module test now pins `json_valid(metadata)` in `extraSql` explicitly.

**Deliberately not done: wrapping the evaluation loop in try/catch.** That would convert this class
of bug into a silent skip. An unexpected SQL error should still surface loudly; the correct fix is a
predicate that does not raise.

## Q2 — Ordering of the new check vs graph-predicate validation · **NO ORDERING ISSUE — but the question found a different real defect**

**On the question as asked: there is nothing to order.** `watcher.create` does not validate
`graphPredicateJson` at all — it does a `typeof v === "string"` check and stores the string verbatim
(`ipc/automation-rpc.ts:115-118`). The malformed-predicate rejection test in that file
(`automation-rpc.test.ts:103`) targets **`watcher.validateCondition`**, a different method. So the new
membership check cannot race or reorder anything.

**But checking that turned up a defect in my plan's own code block.** I had hoisted
`requireString(rec, "conditionType")` above the `name` extraction. Since `requireString` throws on the
first missing field it sees, that silently changed which error a caller gets when *both* `name` and
`conditionType` are missing — a behaviour change nobody asked for, in a PR that claims to change only
which condition types are accepted. Fixed: `name` is extracted first, preserving the existing order.

Credit where due — the question was about a different thing, and asking it is what surfaced this.

## S2 — Confirm the key is `conclusion`, not `result` · **VERIFIED — no change**

`deployment/annotate.ts:169-174` builds the metadata object and writes `conclusion: input.status`,
validated at line 86 against `STATUS_VALUES`, which includes `"failure"`. It is the **only**
production writer of a deployment item carrying an outcome — the other two deployment producers
(`vercel-deployment-mapping.ts`, `prefect-deployment-mapping.ts`) are the ones the plan already
excludes by name. There is no `result` key anywhere on this path, and no webhook path that bypasses
`annotate.ts`.

## S3 — Biome and unbound promises in the new tests · **VERIFIED — no change**

`await expect(...).rejects.toThrow(...)` is already the idiom in the file being edited
(`automation-rpc.test.ts:105-111`), which passes lint on `main` today. The plan's rejection test now
uses exactly that form — it previously used a `.catch()` variant, corrected during the plan's own
self-review for a different reason (`dispatchAutomationRpc` rejects rather than returning an error
value). Task 3 runs `bun run preflight:fast`, which covers Biome, so a lint regression is caught
before push regardless.

## Q1 — Will `extraSql` still be enough when Vercel is added? · **ACCEPTED as a comment**

Short answer: yes, but with a caveat worth writing down where the next author will see it. A single
`extraSql` string *can* express an OR across both shapes
(`metadata.conclusion = 'failure' OR metadata.state = 'ERROR'`). It should not, for long — the moment
a second producer shape lands, the readable move is to widen `WatcherConditionKind` to hold several
predicates per kind rather than grow one long SQL string.

Added to the module's doc comment, alongside the `json_valid` rationale, so both constraints are
visible at the point of change rather than only in this document.

---

## Net effect on the plan

Task 1 gains one SQL guard, one regression test, one assertion, and expanded module comments. Task 2
gains a one-line ordering fix. Tasks and their boundaries are unchanged; no new task, no new file.
