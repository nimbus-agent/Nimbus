# Graph-entity metadata namespacing — Design Review

**Date:** 2026-08-19
**Reviewer:** AI Coding Assistant (Antigravity)

> **Editor's note (2026-08-19, after implementation).** This is a received review, kept as it was
> written; it is a record of what was recommended, not a description of the shipped tree. Two of
> its four-type lists (§ 1.1, § 1.2 recommendation 2) are stale: the shipped co-owned set is SIX
> types — `source_file`, `directory`, `person`, `service`, `workspace`, `repo` — and
> `graph-populator.ts` never writes `directory` at all, so it converted no `directory` site. The
> design spec's § 3 is authoritative for the set and its per-type rationale; `CO_OWNED_ENTITY_TYPES`
> in `packages/gateway/src/graph/relationship-graph.ts` is authoritative for the code.

---

## 1. Critical Safety Concerns & Improvements

### 1.1 Preventing Clobbering by Traditional `upsertGraphEntity` Calls

The design introduces a namespaced variant `upsertGraphEntityNamespaced` but leaves the traditional `upsertGraphEntity` active for single-writer types.

**The Hazard:**
If `graph-populator.ts` (or any other subsystem) calls the traditional `upsertGraphEntity` on a co-owned type (`source_file`, `directory`, `person`, `service`) without providing metadata (e.g., passing `metadata: undefined/null`), the SQL `ON CONFLICT` clause:

```sql
ON CONFLICT (type, external_id) DO UPDATE SET
  metadata = excluded.metadata
```

will evaluate to `NULL` (or empty) and overwrite the entire `metadata` column. This completely defeats namespacing by wiping out the other namespace's data.

**Recommendation:**

1. **Type-level restrictions:** Leverage TypeScript to prevent the traditional `upsertGraphEntity` from being called with co-owned types.

   ```ts
   export type CoOwnedEntityType = "source_file" | "directory" | "person" | "service";

   // Omit co-owned types from the standard upsert signature
   export function upsertGraphEntity(
     db: Database,
     row: {
       type: Exclude<string, CoOwnedEntityType>; // Force compiler error if a co-owned type is passed here
       externalId: string;
       label: string;
       service?: string | null;
       metadata?: Record<string, unknown> | null;
     },
   ): string;
   ```

2. **Force Namespaced Calls:** Convert all call sites for `"source_file"`, `"directory"`, `"person"`, and `"service"` to use `upsertGraphEntityNamespaced` (e.g., `graph-populator.ts` will pass `writer: "symbols"` and `metadata: {}` to safely preserve ownership metadata).

---

## 2. Open Questions & Suggestions

### 2.1 Standardizing Sentinel Values for "Absent" Fields

Since SQLite's `json_patch` treats JSON `null` as a delete instruction (§ 5.1), we cannot store `{ "field": null }` to represent absence.

* **Question:** What is the recommended standard sentinel value for representing known-to-be-absent fields within a namespace?
* **Suggestion:** We should define a helper type or standard convention, e.g., omitting the key entirely, or using a Boolean `false` / empty string `""` depending on the schema, or explicitly documenting a sentinel like `"__absent__"` to ensure future writers do not introduce silent deletions.

### 2.2 Resiliency in the Read API (`readEntityMetadata`)

The design specifies that `readEntityMetadata` returns the writer's namespace or `null`.

* **Question:** How should the read API behave if it encounters a row that hasn't been migrated yet (e.g., flat metadata written during a race condition or if the migration failed)?
* **Suggestion:** To make the rollout more resilient, `readEntityMetadata` could fall back to treating flat metadata as the `"ownership"` namespace if no namespaced keys (like `"ownership"` or `"symbols"`) are found at the root level:

  ```ts
  // Pseudo-logic for fallback
  if (parsed && !("ownership" in parsed) && !("symbols" in parsed)) {
    if (writer === "ownership") {
      return parsed; // Treat existing flat data as ownership namespace
    }
  }
  ```

### 2.3 Exact SQL Expression for Migration V54

To ensure idempotence and prevent double-wrapping, the SQL query for the migration must carefully identify "not already namespaced" rows.

* **Suggestion:** Standardize the check in the migration script using SQLite's JSON functions. For example:

  ```sql
  UPDATE graph_entity
  SET metadata = json_object('ownership', json(metadata))
  WHERE type IN ('source_file', 'directory', 'person', 'service')
    AND metadata IS NOT NULL
    AND json_valid(metadata)
    -- Ensure it is not already wrapped by checking that the keys are not exclusively known namespaces
    AND json_type(metadata) = 'object'
    AND json_extract(metadata, '$.ownership') IS NULL;
  ```

### 2.4 Guarding via Static Lint Audit

* **Suggestion:** Add an enforcement rule in `scripts/structure-audit/check-nimbus-invariants.ts` to statically search for any calls to `upsertGraphEntity` passing `"source_file"`, `"directory"`, `"person"`, or `"service"`. This ensures that even if TypeScript casting is bypassed, the CI preflight will reject code using the unsafe, non-namespaced upsert for these types.
