# Review: Negation Queries (W6-B.1) Implementation Plan

Below is a detailed review of the proposed execution plan in [2026-08-20-negation-queries.md](./2026-08-20-negation-queries.md), outlining clarifications, suggestions, and potential pitfalls.

---

## 1. Technical Corrections & SQL Joins

### A. Graph Entity Mappings for `--no-downstream-incident` and `--not-reviewed`

The plan mentions matching the join in `packages/gateway/src/graph/relationship-graph.ts` for Task 2. To avoid the common trap of joining `item.id` or `person.id` directly to `graph_relation.from_id`, the review suggests explicitly noting the `graph_entity` bridging queries:

* **For Deployments / Incidents (`buildNoDownstreamIncidentSql`):**
  A deployment `item` maps to a `graph_entity` with `type = 'deployment'` and `external_id = item.id`. The SQL join must look like:

  ```sql
  SELECT i.id AS id
    FROM item i
    JOIN graph_entity e ON e.external_id = i.id AND e.type = 'deployment'
   WHERE i.type = 'deployment'
     AND NOT EXISTS (
           SELECT 1 FROM graph_relation r
            WHERE r.from_id = e.id AND r.type = 'correlates_with'
         )
   ORDER BY i.id
  ```

* **For People / Reviews (`buildNotReviewedSql`):**
  A person maps to `graph_entity` with `type = 'person'` and `external_id = person.id`. The query must query the `person` table and join against the graph entity ID:

  ```sql
  SELECT p.id AS id
    FROM person p
    JOIN graph_entity e ON e.external_id = p.id AND e.type = 'person'
   WHERE NOT EXISTS (
           SELECT 1 FROM graph_relation r
            WHERE r.from_id = e.id
              AND r.type = 'reviewed'
              AND r.created_at >= ?1
         )
  ```

---

## 2. Test Robustness

### A. Task 1 validation error asserting strategy

* In Task 1 Step 2, the tests run CLI commands with no Gateway process running, expecting the command to fail on IPC connection rather than argument validation.
* To ensure the test doesn't pass vacuously on a silent parsing error, assert that the captured error contains socket/connection failure markers (e.g. `connect ENOENT`, `fetch failed`, or similar) rather than just checking that it doesn't match the subcommand errors.

### B. Task 4 `people.list` envelope response verification

* Note that `people.list` (`packages/gateway/src/ipc/people-rpc.ts:83`) currently returns a bare JSON array (not a wrapper object like `{ people: ... }`).
* Thus, in Task 4 Step 2's test assertions, mapping the response IDs should be done directly on the returned array:

  ```typescript
  const ids = (out.value as Array<{ id: string }>).map((p) => p.id);
  ```

  Updating the plan to reflect this bare-array response avoids typescript compilation errors during task execution.
