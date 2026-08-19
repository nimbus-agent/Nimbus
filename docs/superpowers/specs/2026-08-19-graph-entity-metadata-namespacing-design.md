# Graph-entity metadata namespacing — design

**Date:** 2026-08-19
**Status:** IMPLEMENTED. This document is the design as agreed; where the shipped code has
moved past it, `packages/gateway/src/graph/relationship-graph.ts` is authoritative. Two
corrections made after implementation, both noted inline in § 5.1: `json_patch` is RFC 7396
recursive merge, not the top-level-only merge originally assumed (sibling isolation still holds,
by a different mechanism than assumed), and the type-level restriction this section originally
called "rejected as non-functional" does ship, via a form this section did not consider.
**Relationship to other work:** sub-project **A** of the changed-file-indexing effort. **B**
(changed-file indexing + dual-keyspace `source_file`) is a separate spec built on this one.
A is independently valuable — it fixes a live bug — and is a precondition for B.

---

## 1. What this is

`graph_entity.metadata` is last-writer-wins. Where two subsystems write the same entity, each
run destroys the other's metadata. This spec gives those entities a **namespaced** metadata
map so co-owning writers cannot touch each other's data.

It is scoped deliberately narrowly: the four entity types where a collision is **proven**, not
all 27 metadata-writing call sites.

---

## 2. The bug, verified

`graph/relationship-graph.ts`'s `upsertGraphEntity` upserts with:

```sql
ON CONFLICT (type, external_id) DO UPDATE SET
  label = excluded.label,
  service = excluded.service,
  metadata = excluded.metadata
```

All three columns are replaced by whoever wrote last.

**The live consequence.** `ownership/ownership-pass.ts` writes
`metadata: ownerCountsMetadata(ranked)` on `source_file` at three sites (`:489`, `:525`,
`:704`). `graph/graph-populator.ts:497` writes the **same entity** — byte-identical external id
`file:<repoRoot>:<path>`, a convergence that is deliberate — with **no metadata**. So every
`syncCodeSymbolGraph` run sets that metadata to `NULL`.

Those counts are read back through `ownership-store.ts`'s `parseCounts` into
`agents/ownership.ts:48` and rendered at `agents/_lib/render.ts:397` as *"N of M contributor(s)
clear the share floor"*. When they are absent, `render.ts:394` falls through to the branch
intended for **legacy rows written before the ownerCount/ownersAboveFloor split**
(`render.ts:408-409` says so). The next ownership pass restores them, and the next symbol sync
wipes them again.

So `nimbus owners` silently alternates between its real output and its legacy-row fallback,
depending on which pass ran last. No error, no gap note — the brief just quietly says less.

**Why the existing comment did not catch it.** `ownership-pass.ts:479-483` acknowledges a
clobber and calls it "cosmetic — unlike the scoping it would break, which is why file scope
comes from `contains` edges rather than from this column." That paragraph is about **`service`**.
`metadata` is clobbered by the same statement and is not cosmetic.

---

## 3. Scope: the collision is one pair of subsystems

Counting `upsertGraphEntity` call sites by entity type suggests a repo-wide problem — `person`
23, `service` 13, `pr` 11. It is not. Multiple call **sites** are not conflicting **writers**.

Resolved to files, the overlap is a single pair:

| Entity type | Writers |
| --- | --- |
| `source_file` | `ownership/ownership-pass.ts`, `graph/graph-populator.ts` |
| `directory` | `ownership/ownership-pass.ts`, `graph/graph-populator.ts` |
| `person` | `ownership/ownership-pass.ts`, `graph/graph-populator.ts` |
| `service` | `ownership/ownership-pass.ts`, `graph/graph-populator.ts` |

`pr`'s four writers are three connectors covering disjoint repositories plus `agents/premortem.ts`.
Whether those collide is a **different question with no evidence behind it yet**, and it is out of
scope — see § 7.

**Only `source_file` has a proven, user-visible failure.** The other three are the same pair on
the same statement, so the mechanism is identical; they are included because fixing one and
leaving three identical cases behind is how a fix becomes folklore.

---

## 4. Decisions taken (recorded so they are not relitigated)

**D1 — namespace metadata, do not COALESCE.** A rejected alternative was
`metadata = COALESCE(excluded.metadata, graph_entity.metadata)`: two lines, no migration, and it
fixes today's bug because `graph-populator` passes no metadata. It is rejected because it does not
make the entity **safe to co-own** — the moment two writers both want metadata, they collide
again, and sub-project B adds exactly such a writer. It would fix the symptom and leave B holding
the same bag.

**D2 — namespace only the four proven types; leave the other ~25 call sites flat.** 27 call sites
pass metadata. Migrating all of them is a large refactor to solve a problem four of them have. The
namespaced API is available repo-wide and adopted where a second writer actually exists.

**D3 — `label` and `service` are out of scope.**
`label` is written identically by both writers on these types, so there is nothing to preserve.
`service` **is** genuinely clobbered, but `ownership-pass.ts` already works around it by deriving
scope from its own `contains` edges, and that workaround is documented and tested. Changing
`service`'s write semantics would touch every entity type in the repo for no proven defect.
Recorded here so the omission reads as a decision.

**D4 — the migration reshapes only what exists.** On the four types, `ownership-pass.ts` is the
only current metadata writer, so existing rows migrate to `{ "ownership": <existing> }`. No data
is discarded and no writer's history is guessed at.

---

## 5. Design

### 5.1 The write API

`upsertGraphEntity` keeps its current signature for single-writer callers. A sibling handles
co-owned entities:

```ts
export function upsertGraphEntityNamespaced(
  db: Database,
  row: {
    type: string;
    externalId: string;
    label: string;
    service?: string | null;
    writer: EntityMetadataWriter;
    metadata: Record<string, unknown>;
  },
): string;
```

`EntityMetadataWriter` is a closed union — `"ownership" | "symbols"` today, gaining
`"changed_files"` in sub-project B. A closed union means a new writer is a deliberate edit, not a
free-form string that silently creates a fifth namespace through a typo.

**Every write to a co-owned type must go through this function.** Namespacing is worthless if the
flat `upsertGraphEntity` can still be called on `source_file`, `directory`, `person` or `service`:
its `metadata = excluded.metadata` would replace the whole namespaced map with the caller's flat
value — or with `NULL` when it passes none — wiping every sibling namespace in one statement.
That is not hypothetical: it is exactly what `graph-populator.ts:497` does today.

So this spec requires two things, not one:

1. **`graph-populator.ts` converts** its `source_file`, `directory`, `person` and `service` writes
   to the namespaced form, passing `writer: "symbols"` — with `metadata: {}` where it has nothing
   to record. **`metadata: {}` is not a no-op**: it clears the `"symbols"` namespace to `{}`, but
   it leaves every sibling namespace — in particular `"ownership"`'s owner counts — untouched,
   which is the property this conversion actually depends on.
2. **A static audit rule enforces it** (§ 5.4), because a convention that only exists in prose is
   one careless call site away from silently reintroducing the bug.

**A type-level restriction was considered and rejected as non-functional.** The obvious shape —
typing the flat function's `type` field as `Exclude<string, CoOwnedEntityType>` — does nothing.
`Exclude<T, U>` distributes over a union; `string` is not a union, so `Exclude<string,
"source_file">` evaluates to `string` and every co-owned type still passes. Verified by compiling
`const probe: Exclude<string, "source_file" | "directory"> = "source_file"` under `tsc --strict`
on 2026-08-19: **it compiles clean.** Such a guard would read as enforcement in review and enforce
nothing — the failure mode this repo already records for allow-list guards. Closing the hole
properly at the type level would mean enumerating every entity type in the repo as a union, which
is a far larger change than the defect warrants; the static audit does the job at the right size.

**Correction, made after implementation.** The analysis above is correct about `Exclude<string,
U>` specifically, but its conclusion oversold what was possible: a **generic** type parameter
closes the hole cheaply, for every literal call site, without enumerating the repo's entity
types. The shipped guard is

```ts
type NonCoOwnedType<T extends string> = T extends CoOwnedEntityType ? never : T;

export function upsertGraphEntity<T extends string>(
  db: Database,
  row: { type: NonCoOwnedType<T>; /* … */ },
): string
```

`upsertGraphEntity(db, { type: "source_file", … })` fails to compile: a literal argument narrows
`T` to the literal type `"source_file"` itself, so the conditional resolves at that literal —
`Exclude<string, U>`'s trap (forcing `T` to widen to bare `string`) never applies. This shipped
as the first of two independent layers, both in `relationship-graph.ts` and the audit rule
(§ 5.4); the static audit remains necessary, not redundant — the compiler guard only resolves a
literal `type:` argument at the call site, not one computed through a `string`-typed variable or
reached through a widened generic, and the audit is what covers that gap (and any file added
after the guard shipped). Neither layer alone would be enough; see the audit rule's own comment
in `scripts/structure-audit/check-nimbus-invariants.ts` for the boundary each layer does not
cover.

The merge uses SQLite's `json_patch`, verified available in this repo's `bun:sqlite`.
**`json_patch` implements RFC 7396 JSON Merge Patch, which is recursive — not the top-level-only
merge originally assumed here.** Verified directly against this repo's `bun:sqlite` on
2026-08-19:

```text
json_patch('{"ownership":{"a":1,"stale":true}}', '{"ownership":{"a":9}}')
  → {"ownership":{"a":9,"stale":true}}        -- "stale" SURVIVES
```

A single call — `json_patch(COALESCE(graph_entity.metadata, '{}'), excluded.metadata)`, the form
originally proposed here — recursively merges a writer's new namespace *into* its own previous
one, field by field, so a stale field the writer meant to drop would leak forward forever. Sibling
isolation, this design's primary property, does still hold under a recursive merge: a top-level
patch object containing only the acting writer's key can never touch a sibling top-level key,
recursive or not.

To get true wholesale replacement of the writer's **own** namespace, the shipped
`upsertGraphEntityNamespaced` (`graph/relationship-graph.ts`) applies `json_patch` **twice**:
first with `{"<writer>": null}`, which RFC 7396 defines as deleting that key outright, then with
`{"<writer>": <metadata>}` against the now-key-free object, so the second call inserts fresh
rather than merging into anything:

```sql
metadata = json_patch(json_patch(COALESCE(graph_entity.metadata, '{}'), ?/* null-patch */), ?/* set-patch */)
```

The same wrapping applies on first insert. An earlier version of this code wrote the raw
namespace value straight into the `metadata` column on `INSERT`, skipping `json_patch` entirely
— so a first-ever write with an explicit `null` field stored `null` verbatim instead of being
deleted, unlike every subsequent write to that row. The shipped insert path is
`json_patch('{}', <set-patch>)`, going through the same delete-on-`null` semantics as the update
path, so insert and update agree. See `upsertGraphEntityNamespaced`'s doc comment for the
authoritative statement of this mechanism.

**A confirmed hazard, not a suspected one.** `json_patch` treats a JSON `null` value as a
**delete** instruction, so a writer whose namespace legitimately contains a `null` field has that
field silently removed rather than stored. Verified against this repo's `bun:sqlite` on
2026-08-19:

```text
json_patch('{"ownership":{"a":1}}', '{"symbols":{"b":null}}')
  → {"ownership":{"a":1},"symbols":{}}
```

`b` is gone, not stored as `null`. `ownerCountsMetadata` returns numbers, so this does not bite
today — but sub-project B's writer must not assume otherwise. Pinned by a test so the next reader
inherits the fact rather than rediscovering it.

**The convention for "absent", so it is not invented per writer: omit the key.** Absence is the
representation; `readEntityMetadata` yields `undefined` for a missing field either way, so writing
`null` buys nothing and silently deletes. A magic sentinel such as `"__absent__"` was considered
and rejected — it is a second thing every reader must know, and a writer that forgets it is back
to a silent delete. Where a writer must genuinely distinguish *computed and found nothing* from
*not computed*, it records that as an explicit non-null field of its own — a count of `0`, or a
boolean — never as a `null` and never as a sentinel string.

### 5.2 The read API

One accessor, in `graph/relationship-graph.ts`:

```ts
export function readEntityMetadata(
  raw: string | null,
  writer: EntityMetadataWriter,
): Record<string, unknown> | null;
```

It returns the writer's namespace, or `null` when absent or when `raw` is unparseable. It must not
throw on malformed JSON — `graph_entity.metadata` is written by many paths and a parse failure
must degrade to "no metadata" rather than break a read.

`ownership-store.ts`'s `parseCounts` is the only current reader of these four types' metadata and
is repointed through it.

**No flat-metadata fallback, deliberately.** A resilience fallback was considered — if no known
namespace key is present at the root, treat the whole object as the `ownership` namespace — and
rejected. It would mask the precise failure this spec exists to prevent: a flat write landing on a
co-owned type (§ 5.1) produces exactly that shape, and the fallback would render it as valid
ownership data instead of surfacing the clobber. A failed or skipped V54 would likewise read as
success. Migrations here run at startup before any read, so the race the fallback guards against
is not a real window; what it would actually buy is silence over the one symptom worth seeing.

### 5.4 Static enforcement

A new rule in `scripts/structure-audit/check-nimbus-invariants.ts` fails the build when
`upsertGraphEntity` — the flat one — is called with `type:` set to any co-owned type
(`source_file`, `directory`, `person`, `service`) outside `graph/relationship-graph.ts` itself.

This is the repo's established mechanism for exactly this shape of rule, it runs before the test
suite, and it is what makes § 5.1's requirement real rather than advisory. It is also the reason
the rejected type-level trick is not merely suboptimal but unnecessary.

Write the rule as **what cannot pass**, and red-prove it by temporarily pointing one
`graph-populator.ts` co-owned write back at the flat function and confirming the audit fails.
A guard nobody has seen reject anything is a guard nobody knows works.

### 5.3 Migration V54

For `graph_entity` rows of type `source_file`, `directory`, `person` or `service` with non-null,
`json_valid` metadata that is **not already namespaced**, rewrite to `{"ownership": <existing>}`.

Idempotence matters because migrations here are forward-only and the runner may re-enter: the
"not already namespaced" test is that **no top-level key equals any known writer name** — not
merely that `$.ownership` is absent, which would still re-wrap a row shaped `{"symbols": …}`.
That case cannot arise before this migration, since `ownership` is the only current writer on
these types, but the broader check costs nothing and does not depend on that staying true.

```sql
UPDATE graph_entity
SET metadata = json_object('ownership', json(metadata))
WHERE type IN ('source_file', 'directory', 'person', 'service')
  AND metadata IS NOT NULL
  AND json_valid(metadata)
  AND json_type(metadata) = 'object'
  AND NOT EXISTS (
    SELECT 1 FROM json_each(graph_entity.metadata)
    WHERE json_each.key IN ('ownership', 'symbols')
  );
```

`json(metadata)` rather than bare `metadata` — without it the existing object is stored as an
escaped string rather than nested JSON. `json_type(metadata) = 'object'` excludes a row whose
metadata is a valid JSON scalar or array, which `json_each` would otherwise iterate positionally.

Rows whose metadata is `NULL` or fails `json_valid` are left untouched — there is nothing to
preserve, and `readEntityMetadata` already degrades to `null` for them.

---

## 6. Testing

- **The bug, as a regression test:** run the ownership pass over a blame fixture, assert the
  counts; run `syncCodeSymbolGraph` over the same file; assert the counts **survive**. This test
  fails against `main` today — red-prove it that way, not by writing it green.
- **Namespace isolation:** two writers write the same entity; each reads back only its own data,
  and neither sees nor loses the other's.
- **`json_patch` null semantics:** a namespace containing an explicit `null` field — assert the
  observed behaviour so § 5.1's caution is pinned rather than described.
- **Malformed metadata:** `readEntityMetadata` returns `null` and does not throw.
- **Migration idempotence:** running V54 twice yields the same rows; an already-namespaced row is
  not double-wrapped.
- **Migration leaves other types alone:** a `pr` or `incident` row's flat metadata is unchanged.
- **`nimbus owners` renders the real line, not the legacy fallback**, after a symbol sync — the
  user-visible assertion behind the whole spec.
- **The static audit rejects a flat write to a co-owned type** (§ 5.4), red-proved by pointing one
  `graph-populator.ts` write back at `upsertGraphEntity` and confirming the audit fails.
- **`metadata: {}` under `json_patch` clears the writer's own namespace but does not wipe a
  sibling's** — the property `graph-populator`'s converted writes depend on, and not the same
  thing as a true no-op. Assert an existing sibling namespace survives such a write.
- **`readEntityMetadata` does NOT resurrect flat metadata** as the `ownership` namespace: a row
  with flat metadata returns `null`, so a clobber or a skipped migration stays visible (§ 5.2).

---

## 7. Out of scope

No new invariant, no new IPC method, no new HTTP route, no Tauri allowlist change, no connector
change.

- **`pr`'s four writers.** Three connectors covering disjoint repositories plus `agents/premortem.ts`.
  Whether they collide is unverified; asserting they do would repeat the mistake this spec exists
  to fix. If a collision is found, the API from § 5.1 already fits.
- **`service` and `label` clobbering** (D3).
- **The other ~25 flat-metadata call sites** (D2).
- **Sub-project B** — changed-file indexing and the dual `source_file` keyspace — which consumes
  this API and gets its own spec.
