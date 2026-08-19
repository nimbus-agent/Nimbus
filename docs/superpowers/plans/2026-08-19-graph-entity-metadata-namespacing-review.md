# Graph-Entity Metadata Namespacing Plan — Review

**Date:** 2026-08-19
**Reviewer:** AI Coding Assistant (Antigravity)

---

## 1. Critical Suggestions & Improvements

### 1.1 Add Compile-Time Type Safety to `upsertGraphEntity`

Task 1 and Task 3 specify implementing `upsertGraphEntityNamespaced` and converting call sites, and Task 4 sets up a regex audit to reject flat calls.

* **Suggestion:** We should enforce this directly in TypeScript in `packages/gateway/src/graph/relationship-graph.ts` as part of **Task 1**.
* **Action:** Restrict the `row.type` argument of the traditional `upsertGraphEntity` to exclude the four co-owned types. This prevents the compiler from accepting unsafe calls during development:

  ```ts
  export type CoOwnedEntityType = "source_file" | "directory" | "person" | "service";

  export function upsertGraphEntity(
    db: Database,
    row: {
      type: Exclude<string, CoOwnedEntityType>;
      externalId: string;
      label: string;
      service?: string | null;
      metadata?: Record<string, unknown> | null;
    },
  ): string;
  ```

### 1.2 Explicitly Reference `CURRENT_SCHEMA_VERSION` Update

In **Task 2, Step 5**, the plan mentions updating any schema-version constants if they exist.

* **Verification:** The current schema version is defined at `packages/gateway/src/index/local-index.ts:265` as:

  ```ts
  export const CURRENT_SCHEMA_VERSION = 53;
  ```

* **Action:** Update the task description to explicitly instruct the implementer to change this constant to `54`.

### 1.3 Audit Rule Robustness (Task 4)

Static regex audits matching calls to `upsertGraphEntity` can be easily bypassed by multi-line formatting or template strings.

* **Suggestion:** Combine the regex check with the TypeScript restriction suggested in § 1.1. The static audit rule in `check-nimbus-invariants.ts` should verify:
  1. No file (other than `relationship-graph.ts`) uses `upsertGraphEntity` with any of the co-owned literal strings.
  2. Any dynamic type variables passed to `upsertGraphEntity` are also statically audited where possible, though the TS compiler type checker will be the primary line of defense.

### 1.4 Note on `ensureGraphEntity` Safety

* **Context:** The codebase also utilizes `ensureGraphEntity` which targets the same tables.
* **Observation:** `ensureGraphEntity` uses `ON CONFLICT (type, external_id) DO NOTHING` and writes `NULL` to metadata on insert only if the entity is missing. It does not overwrite metadata on conflict.
* **Action:** Keep a brief note in the plan explaining why `ensureGraphEntity` is safe to leave flat, clarifying this boundary for the developer.
