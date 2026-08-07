# Design Review: Ticket depth — Jira + Linear (S1 / workstream A, PR D1)

This design review outlines open questions, improvements, and architectural suggestions for the ticket depth specification.

---

## 1. Critical Design Gap: The 30-Day Sync Window Constraint

### The Issue
The design states:
> Already-indexed rows keep their old two-key metadata until the connector re-walks them... `nimbus index rebody` clears the scheduler cursor (watermark) to force a sync.

However, both `connectors/jira-sync.ts` and `connectors/linear-sync.ts` hardcode `initialSyncDepthDays = 30` as a fallback when the cursor is cleared (`null`). 
- In Jira: `updated >= -30d`
- In Linear: `floorMs = Date.now() - 30 * 86_400_000`

If the cursor is cleared for `rebody`, **only tickets updated/modified in the last 30 days will be re-fetched**. Any historical closed tickets from months or years ago (which are precisely the target of the `pre-mortem` agent's analysis) will remain stale with their old two-key metadata.

### Suggested Solutions
1. **Dynamic Sync Depth Support in SyncContext:** Allow `SyncContext` or the sync parameters to override `initialSyncDepthDays` during a `rebody` operation (e.g., setting a depth of 365+ days or unlimited).
2. **Rebody-Specific Query:** If the sync service is called from `rebody`, pass a flag/context that signals the sync handler to fetch all historical items or use a much longer default depth.

---

## 2. Status Category Normalization

### The Issue
Jira and Linear use different vocabularies for status categories:
- Jira: `new` / `indeterminate` / `done`
- Linear: `backlog` / `unstarted` / `started` / `completed` / `canceled`

If `status_category` is stored exactly as returned by the platform, the consuming agents (`pre-mortem`, etc.) must maintain custom translation logic for each service provider.

### Suggested Solutions
Normalize the status categories at the sync mapper level into a unified vocabulary. For example:
- `todo` (Jira: `new`, Linear: `backlog` / `unstarted`)
- `in_progress` (Jira: `indeterminate`, Linear: `started`)
- `done` (Jira: `done`, Linear: `completed`)
- `cancelled` (Linear: `canceled`)

---

## 3. Hierarchy: Linear Project vs Parent Issue

### The Issue
The design handles Jira's Epics and Linear's Projects/Parents as:
> `pre-mortem` groups Linear issues by project and Jira issues by `issue_type = 'Epic'` / `parent_key`.

In Linear, issue hierarchies can be deeper (e.g. parent issues acting as epics/sub-tasks). Since the Linear sync will now query `parent { identifier }`, we should ensure the mapping cleanly supports linking child issues to parent issues, matching how Jira's `parent_key` maps child issues to parent issues (or epics).

### Suggestion
Verify that `parent_key` is populated with `parent.identifier` for Linear, so the consumer can build parent-child relations uniformly across both platforms without relying on `project_id` alone.

---

## 4. Quota and Rate Limit Protection

### The Issue
Force-syncing active integrations from scratch can consume significant API quota and hit rate limits. While the `IndexRebodyRpc` has quota protections, we should ensure the backfill handles rate limits gracefully.

### Suggestion
Verify that the `jira-sync` and `linear-sync` rate-limiting policies (`ctx.rateLimiter.acquire`) are fully respected and won't cause sync aborts midway during a large backfill.
