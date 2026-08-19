# Design Review Response: graph-entity metadata namespacing

Response to [`2026-08-19-graph-entity-metadata-namespacing-design-review.md`](./2026-08-19-graph-entity-metadata-namespacing-design-review.md).
Every item checked against the tree on 2026-08-19 before being accepted or declined.

**Outcome:** 4 accepted, 1 rejected. The headline finding is correct and important; the mechanism
it proposed does not work, and I verified that rather than adopting it.

| # | Item | Outcome | Spec change |
| --- | --- | --- | --- |
| 1.1a | Flat `upsertGraphEntity` defeats namespacing | **Accepted — the central gap** | § 5.1 |
| 1.1b | Enforce via `Exclude<string, CoOwned>` | **Rejected — verified inert** | § 5.1 |
| 2.1 | Standard sentinel for "absent" | **Accepted, different answer** | § 5.1 |
| 2.2 | Read-side fallback for unmigrated rows | **Rejected — masks the failure** | § 5.2 |
| 2.3 | Exact migration SQL | **Accepted, check widened** | § 5.3 |
| 2.4 | Static audit rule | **Accepted, promoted to primary enforcement** | § 5.4 |

---

## 1.1a — the flat upsert defeats namespacing: correct, and the spec's central gap

The spec introduced `upsertGraphEntityNamespaced` and left the flat `upsertGraphEntity` available
"for the ~25 single-writer call sites". It never said what stops the flat one being called on a
co-owned type — and the answer was nothing.

Worse than hypothetical: `graph-populator.ts:497` calls the flat function on `source_file` with no
metadata **today**. That is the exact statement causing the bug this spec exists to fix. A design
that adds a safe alternative while leaving the unsafe path reachable from the very code that
misuses it has not fixed anything; it has added an option.

§ 5.1 now requires two things instead of one: `graph-populator.ts` converts its four co-owned
writes to the namespaced form (`writer: "symbols"`, `metadata: {}` where it has nothing to
record — a `json_patch` no-op that preserves siblings), and a static audit makes the requirement
enforceable rather than advisory.

---

## 1.1b — the `Exclude` restriction: rejected, verified non-functional

The proposed enforcement was:

```ts
type: Exclude<string, CoOwnedEntityType>; // Force compiler error
```

**This does nothing.** `Exclude<T, U>` is `T extends U ? never : T`, distributing over a union.
`string` is not a union, so `string extends "source_file"` is false and the whole expression
evaluates back to `string`. Every co-owned type still passes.

Verified rather than reasoned about — compiled under `tsc --strict` on 2026-08-19:

```ts
type Restricted = Exclude<string, "source_file" | "directory">;
const probe: Restricted = "source_file";   // compiles clean
```

No error. Shipping it would have produced a guard that reads as enforcement in review, passes
CI, and rejects nothing — the "allow-list guards fail silently" failure this repo has already
paid for once. Closing the hole at the type level properly would mean typing `type` as a closed
union of every entity type in the repo, which is a far larger change than this defect justifies.

The concern behind the recommendation is right; § 5.4 implements it with a mechanism that
actually fires, which is the review's own 2.4.

---

## 2.1 — sentinel for "absent": accepted, with a different answer

The question is the right one to ask, given `json_patch` deletes on `null`. The suggestion offered
three candidates including an explicit `"__absent__"` marker.

**The convention is: omit the key.** Absence is already the representation — `readEntityMetadata`
yields `undefined` for a missing field either way, so writing `null` buys nothing and silently
deletes. A magic sentinel is a second rule every reader must know, and a writer that forgets it is
straight back to a silent delete; it adds a failure mode instead of removing one.

Where a writer genuinely needs to distinguish *computed and found nothing* from *not computed*, it
records that as an explicit non-null field of its own — a count of `0`, or a boolean — never a
`null`, never a sentinel string. Recorded in § 5.1 so sub-project B inherits it.

---

## 2.2 — read-side fallback for unmigrated rows: rejected

The suggestion was that `readEntityMetadata`, finding no known namespace key at the root, treat
the whole object as the `ownership` namespace.

Rejected, because it would mask precisely the failure this spec exists to prevent. A flat write
landing on a co-owned type — item 1.1a — produces exactly that shape. With the fallback, that
clobber renders as valid ownership data instead of surfacing; so would a V54 that failed or was
skipped. The fallback's own justification is the case where it does most harm.

The race it guards against is also not real: migrations run at startup, before any read, and the
runner records them. What the fallback would actually buy is silence over the one symptom worth
seeing.

§ 5.2 records the rejection with that reasoning, and § 6 adds a test asserting a flat-metadata row
returns `null` — so the absence of the fallback is pinned rather than merely intended.

---

## 2.3 — migration SQL: accepted, with the idempotence check widened

The supplied SQL is close to right and now appears in § 5.3. Two changes:

**The "already namespaced" test was too narrow.** `json_extract(metadata,'$.ownership') IS NULL`
still re-wraps a row shaped `{"symbols": …}`. That cannot arise before this migration, since
`ownership` is the only current writer on these types — but the check should not depend on that
staying true. Widened to "no top-level key is a known writer", via `NOT EXISTS (SELECT 1 FROM
json_each(...) WHERE key IN ('ownership','symbols'))`.

**Kept and documented, because both are easy to drop:** `json(metadata)` rather than bare
`metadata`, without which the existing object is stored as an escaped string rather than nested
JSON; and `json_type(metadata) = 'object'`, which excludes a valid JSON scalar or array that
`json_each` would otherwise iterate positionally.

---

## 2.4 — static audit rule: accepted, and promoted

Offered as a defence-in-depth suggestion; it is now the **primary** enforcement (§ 5.4), because
1.1b's type-level alternative does not work.

A rule in `scripts/structure-audit/check-nimbus-invariants.ts` fails the build when the flat
`upsertGraphEntity` is called with a co-owned `type:` outside `relationship-graph.ts` itself. This
is the repo's established mechanism for this shape of rule and it runs before the test suite.

One addition the review did not ask for: the rule must be **red-proved** — point one
`graph-populator.ts` co-owned write back at the flat function, confirm the audit fails, restore.
A guard nobody has seen reject anything is a guard nobody knows works, and this branch is
specifically about a protection that looked present and was not.
