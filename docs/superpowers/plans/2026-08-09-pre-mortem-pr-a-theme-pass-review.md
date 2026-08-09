# Plan Review: `nimbus pre-mortem` PR A (Theme Pass)

This document contains feedback, open questions, and suggestions for the implementation plan [2026-08-09-pre-mortem-pr-a-theme-pass.md](./2026-08-09-pre-mortem-pr-a-theme-pass.md).

---

## 1. Critical Architecture Discrepancy: Service Axis (Affected vs. Connector)

### The Discrepancy

* **The Design Spec states:**
  * *"The cohort is selected by service overlap: past epics that touched some of the same services as the target."*
  * *"The recurring blockers for `billing-api` serve every epic that touches it."*
  * *"discover -> closed epics + their children's ticket bodies and mentioning threads, grouped by service"*
* **The Implementation Plan (Task 5 & Task 7) states:**
  * *"Service here is the connector service (jira / linear) that owns the row — the theme's service key. PR B maps a cohort's affected services separately; these are not the same axis and must not be conflated."*
  * In Task 7, `upsertTheme` groups themes by the epic's `item.service` (which is `'jira'` or `'linear'`).

### Why this is a blocker

If `premortem_theme` stores themes under `'jira'` or `'linear'` as the service:

1. All Jira epics will share the exact same set of themes, regardless of whether they touch `billing-api`, `search`, or `auth`.
2. The request path (PR B / Lane 4) which queries themes by the *affected* services (derived from child PRs → repos) will look for themes with `service = 'billing-api'` and find **zero results**, because they were all saved under `service = 'jira'`.
3. This completely defeats the purpose of the service-overlap design.

### Solution / Suggestion

The background pass MUST resolve the affected services for each discovered epic during the background extraction pass (similar to how PR B's Lane 1 will do it), and write the themes under the *affected* services rather than the *connector* service.
Specifically:

* For each discovered epic, traverse its child tickets to their PRs and determine the repositories/services affected.
* Group/write the extracted themes under those affected services in `premortem_theme`.

---

## 2. Empty or Invalid Theme Labels

In Task 2, `normalizeThemeLabel` does:

```ts
export function normalizeThemeLabel(raw: string): string {
  return raw.replace(EDGE_PUNCTUATION, "").toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}
```

* **Risk:** If the LLM returns a label that consists entirely of punctuation (e.g. `"..."` or `""""`), `normalizeThemeLabel` will return an empty string `""`. Passing `""` to `themeId` will succeed, and `upsertTheme` will write a theme with an empty label to the database.
* **Suggestion:** Add validation in `extractThemes` (Task 6) or `upsertTheme` (Task 3) to discard/ignore empty normalized labels.

---

## 3. Orphaned Evidence Rows Cleanup

In Task 3, `demoteThemesWithNoLiveEvidence` checks for themes where `NOT EXISTS` a live item matching the evidence.

```ts
export function demoteThemesWithNoLiveEvidence(db: Database, nowMs: number): number {
  const stale = db
    .query(
      `SELECT t.id FROM premortem_theme t
        WHERE t.status = 'extracted'
          AND NOT EXISTS (
            SELECT 1 FROM premortem_theme_evidence e
              JOIN item i ON i.id = e.item_id
             WHERE e.theme_id = t.id
          )`,
    )
    ...
```

* **Issue:** The table `premortem_theme_evidence` does not have a foreign key references constraint to `item(id)` (since items are synced/deleted dynamically). If items are pruned or deleted from the `item` table, their referencing rows in `premortem_theme_evidence` remain in the database forever as dead/orphaned rows.
* **Suggestion:** During the reconciliation/demotion sweep, delete the orphaned rows from `premortem_theme_evidence` where `item_id NOT IN (SELECT id FROM item)` to prevent database bloat and speed up subsequent query execution.

---

## 4. Nullability and Default for `occurredAt`

In Task 7, `runPremortemPass` maps `occurredAt` to `resolvedAtMs ?? 0`:

```ts
occurredAt: byId.get(id)?.resolvedAtMs ?? 0,
```

* **Open Question:** If an epic's resolution time is unknown/null, setting `occurredAt` to `0` represents `1970-01-01`.
* **Suggestion:** Since `occurred_at` in the DDL is nullable (`occurred_at INTEGER`), it's better to pass `undefined` or `null` instead of `0` when `resolvedAtMs` is missing/zero, keeping the data clean.
