# Plan Review Response: graph-entity metadata namespacing

Response to [`2026-08-19-graph-entity-metadata-namespacing-review.md`](./2026-08-19-graph-entity-metadata-namespacing-review.md).
Every item checked against the tree on 2026-08-19 before being accepted or declined.

**Outcome:** 3 accepted, 1 rejected-with-substitute. The rejected one is a repeat of a design-review
recommendation I had already compiled and found inert — but the instinct behind it was right, and
chasing it turned up a version that actually works.

| # | Item | Outcome | Plan change |
| --- | --- | --- | --- |
| 1.1 | Compile-time guard via `Exclude<string, CoOwned>` | **Mechanism rejected, goal accepted** | Task 1 Step 4b |
| 1.2 | Update `CURRENT_SCHEMA_VERSION` | **Accepted** | Task 2 Step 5 |
| 1.3 | Audit rule robustness | **Accepted, sharpened** | Task 4 Step 1 |
| 1.4 | Note why `ensureGraphEntity` is safe | **Accepted** | Task 3 Step 4 |

---

## 1.1 — the compile-time guard: right goal, wrong mechanism, working substitute found

This is the second time `Exclude<string, CoOwnedEntityType>` has been recommended — the design
review proposed it, I compiled it, and it does nothing. Repeating the verification rather than
the assertion:

```ts
const p: Exclude<string, "source_file" | "directory"> = "source_file";  // compiles clean
```

`Exclude<T, U>` distributes over a union. `string` is not a union, so `string extends
"source_file"` is false and the whole expression evaluates back to `string`. Every co-owned type
still passes. Shipping it would produce a guard that reads as enforcement in review, passes CI,
and rejects nothing.

**But the reviewer is right that a compile-time guard beats a regex**, and pushing on that turned
up a form that works. Making the function generic in its type parameter gives the compiler a
literal to narrow:

```ts
type NonCoOwnedType<T extends string> = T extends CoOwnedEntityType ? never : T;
declare function upsertFlat<T extends string>(row: { type: NonCoOwnedType<T> }): void;
```

Verified under `tsc --strict`, all three cases:

```text
upsertFlat({ type: "pr" })           → compiles       ✓ correct
upsertFlat({ type: "source_file" })  → TS2322 error   ✓ correct
const d: string = "source_file";
upsertFlat({ type: d })              → compiles       ✗ degrades — no literal to narrow
```

Added as Task 1 Step 4b, with all three lines recorded so the next reader inherits the limits
rather than the headline.

**The third line is why § 1.3's audit stays.** The reviewer framed the compiler as "the primary
line of defence" with the audit as backup. It is closer to the reverse: the compiler is the
faster feedback but the narrower net, since it sees only literals. The audit catches literals in
any file; neither resolves a type computed at runtime. The plan now ships both and says in Task 4
what neither catches — an honest guard records its own gaps.

Also added: two `@ts-expect-error` compile-assertion tests, one per direction. `@ts-expect-error`
fails the build when the error it expects **stops** occurring, so the guard cannot rot into a
no-op unnoticed — which is precisely how the `Exclude` version would have failed.

---

## 1.2 — `CURRENT_SCHEMA_VERSION`: accepted

Verified: `packages/gateway/src/index/local-index.ts:265` reads
`export const CURRENT_SCHEMA_VERSION = 53;`, exactly as reported.

My Task 2 Step 5 said "if the runner also maintains … a schema-version constant, update it" —
a conditional pointing at a file I had not checked. Naming the file, the line and the new value
is strictly better, and removes an "if" that an implementer could resolve as "it doesn't".

Task 2 Step 5 now states it as confirmed, with the consequence spelled out: a step registered
while the constant still reads `53` is a half-landed migration — the step exists and nothing
believes the schema moved.

---

## 1.3 — audit robustness: accepted, and sharper than raised

The concern was that a regex can be bypassed by multi-line formatting. That understates it for
this codebase: the call being matched is **normally** written as

```ts
upsertGraphEntity(db, {
  type: "source_file",
```

so a single-line regex would miss **every real occurrence** and pass vacuously from day one. Not
a bypass an adversary needs to find — the default formatting.

Task 4 Step 1 now requires a multi-line match, bounded so it cannot span into a following call,
and requires the red-prove to use a **multi-line call site specifically**, since that is the only
shape present in the tree. Red-proving against a contrived single-line call would leave the real
gap open while looking proven.

The suggestion to also audit dynamic type variables is declined as YAGNI: no call site in the
tree computes an entity type at runtime, so the rule would guard a shape that does not exist.
Task 4's comment records that gap explicitly instead, which is the honest handling — a rule
claiming totality it does not have is worse than one that states its edge.

---

## 1.4 — `ensureGraphEntity`: accepted

Verified at `relationship-graph.ts:95-97` — it upserts with `ON CONFLICT (type, external_id) DO
NOTHING`, so it writes metadata only when inserting a row that did not previously exist and can
never overwrite another writer's namespace. The observation is correct.

Worth the note for a reason beyond reassurance: without it, an implementer converting writers in
Task 3 may reasonably wonder whether the sibling function needs the same treatment, and either
convert it as churn or stall asking. The note is now in Task 3 Step 4, and states the underlying
rule rather than just the verdict — the flat/namespaced split tracks *"does this statement
overwrite metadata"*, and `DO NOTHING` does not.
