# Review of Incident Attribution — PR 2 (Sentry) Implementation Plan

**Date:** 2026-08-14
**Plan File:** [2026-08-14-incident-attribution-pr2-sentry.md](./2026-08-14-incident-attribution-pr2-sentry.md)

---

## 1. Safety & Robustness Audits

### 1.1 `assignedTo` Shape and `asRecord` Integration

In **Task 1 Step 3**, the helper `sentryAssigneeEmail` is proposed:

```ts
function sentryAssigneeEmail(metadata: Record<string, unknown>): unknown {
  const actor = asRecord(metadata["assignedTo"]);
  if (actor === undefined) return undefined;
  return stringField(actor, "type") === "user" ? actor["email"] : undefined;
}
```

* **Observation:** Sentry `assignedTo` can sometimes be nested or malformed if the sync model changes or receives raw API drift.
* **Verification:** `asRecord` correctly guards against arrays and primitives by returning `undefined` if they are not plain objects. `stringField` (defined locally in `graph-populator.ts`) safely handles non-string properties or missing properties by returning `undefined` or a blank string. Thus, `stringField(actor, "type") === "user"` will evaluate to `false` and fail-closed correctly.
* **Recommendation:** Ensure that the local `stringField` function from `graph-populator.ts` behaves as expected when handed a missing key (e.g., does not throw on undefined/null values).

---

## 2. Test Suite & Type-Safety Improvements

### 2.1 Strictly Typed Test Query Assertions

In **Task 1 Step 1**, the helper `assignedEdges` casts the query return:

```ts
.all() as Array<{ from_ext: string; to_ext: string }>
```

* **Suggestion:** Depending on how strict the Bun SQLite typings are in this workspace, `db.query(...).all()` may return `unknown[]`. Verify that this explicit cast compiles cleanly without requiring intermediate `as unknown` conversions under strict mode.

### 2.2 Updating Test Fixture Helpers

In **Task 2 Step 4**, the plan mentions:
> Any existing test constructing a `NegotiateIncidents` literal now needs the new required field — `typecheck` will name them; update rather than making the field optional.

* **Suggestion:** Specifically, `emptyNegotiateBriefForRender(db)` (or similar stub generators in `negotiate.test.ts`) must be updated to include `errorIssuesAssigned: 0`. Adding this specific location to the plan avoids unnecessary compile-loop iterations.

---

## 3. Honesty & Gap-Note Assertions

### 3.1 Distinct Zero checks

* **Praise:** The plan correctly isolates `error_issue` attribution zero checks from general `incident` checks. By suppressing rendering at `0` for error issues, it adheres strictly to Spec B § 5.8 to prevent misinterpretation of "measured zero" vs. "missing data".
