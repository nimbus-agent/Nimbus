# Review & Feedback: Stage A — Gateway Paginated-Sync Helper Implementation Plan

**Date:** 2026-06-17
**Related Plan:** [2026-06-17-jscpd-dedup-stage-a-paginated-sync.md](file:///C:/gitrep/Nimbus/.claude/worktrees/jscpd-dedup/docs/superpowers/plans/2026-06-17-jscpd-dedup-stage-a-paginated-sync.md)

---

## 1. Open Questions

### Q1.1: Exception Handling in `upsertMapped`
* **Context:** In Task 1, `upsertMapped` is defined as:
  ```typescript
  export function upsertMapped(
    ctx: SyncContext,
    items: readonly unknown[],
    map: (raw: unknown) => SyncUpsertRow | null,
  ): number { ... }
  ```
* **Question:** If mapping fails or throws an exception for a specific item (e.g. unexpected property type inside `map`), should this crash the entire synchronization run, or should it log the error and continue mapping subsequent items?
* **Recommendation:** Ensure this behavior aligns exactly with the existing connectors. If current connectors throw and fail the sync, then letting the error propagate is correct. If any current connectors catch mapping errors on a per-item level, we may need to allow an optional `onError?: (error: unknown, item: unknown) => void` handler in the spec. (Note: Initial resolution suggests declining the optional `onError` handler as Tier-1 connectors do not wrap mapping in try/catch, but it is critical to verify this remains true for all 18 batched connectors).

### Q1.2: Diagnostic Logging on `maxPages` Limit Reached
* **Context:** The `runSinglePassPaginatedSync` helper terminates when the page loop reaches `spec.maxPages`.
* **Question:** If a connector halts because it reached `maxPages` but `hasMore` is still `true`, this indicates that client data is being truncated. Should the helper log a warning (e.g., `ctx.logger.warn("Sync reached maxPages cap; output might be truncated")`) to make this limit visible in production logs?

### Q1.3: Handling Continuation-Token and Cursor-Based Pagination
* **Context:** In Task 2, `fetchPage` is defined as:
  ```typescript
  readonly fetchPage: (creds: C, page: number) => Promise<FetchOutcome>;
  ```
  However, several Tier-1 connectors (like Canva, HubSpot, Miro, Intercom, Salesforce) use cursor or continuation token pagination (e.g. Canva's `continuation` or HubSpot's `after` query parameters), where the next request's path/parameters depend on a token extracted from the *previous* response's parsed JSON payload.
* **Question:** With only `page: number` passed to `fetchPage`, how can continuation-token/cursor-based connectors fetch the next page?
* **Recommendation:** Update the signature of `fetchPage` to include the previous page's `FetchOutcome` (or its parsed payload) so that the callback can extract the next token/cursor:
  ```typescript
  readonly fetchPage: (creds: C, page: number, previousOutcome: FetchOutcome | null) => Promise<FetchOutcome>;
  ```
  Inside the `runSinglePassPaginatedSync` loop, track and propagate `prevOutcome`:
  ```typescript
  let prevOutcome: FetchOutcome | null = null;
  for (let i = 0; i < spec.maxPages; i += 1) {
    const page = startPage + i;
    const outcome = await spec.fetchPage(creds, page, prevOutcome);
    prevOutcome = outcome;
    // ...
  ```

---

## 2. Suggestions & Improvements

### Suggestion 2.1: Make `ensureRunning` Optional
* **Problem:** In Task 2, `ensureRunning` is defined as a required async function in `PaginatedSyncSpec<C>`. For connectors that do not have associated MCP server processes (e.g., standard REST APIs like Canva, Netlify, readwise), this forces developers to write boilerplate empty functions: `ensureRunning: async () => {}`.
* **Improvement:** Make `ensureRunning` optional in `PaginatedSyncSpec<C>` and check for its presence in the helper:
  ```typescript
  export interface PaginatedSyncSpec<C> {
    readonly ensureRunning?: () => Promise<void>;
    // ...
  }
  ```
  Inside `runSinglePassPaginatedSync`:
  ```typescript
  if (spec.ensureRunning) {
    await spec.ensureRunning();
  }
  ```
  This reduces boilerplate across the 21 migrated files.

### Suggestion 2.2: Ensure Correct `Date.now()` Timing (Synced At)
* **Problem:** The helper records `const now = Date.now();` once at the beginning of the page loop.
* **Improvement:** Confirm that this aligns with the original sync behavior where some syncs might have queried `Date.now()` inside the loop vs outside. Having it evaluated once before the loop is generally faster and avoids minor timestamp drift between mapped records, which is a good standard practice.

### Suggestion 2.3: Type Safety of the `map` Function's Second Parameter
* **Problem:** The `map` function parameter:
  ```typescript
  readonly map: (raw: unknown, now: number) => SyncUpsertRow | null;
  ```
  requires passing the current timestamp (`now`) as a `number`.
* **Improvement:** Some mappings might not need the `now` timestamp or might require a full options object (e.g., `{ syncedAt: now }`). Providing the timestamp or matching context structure as a second parameter is excellent. We should verify that all 21 connectors use exactly `syncedAt: now` format or if any require separate mapping parameters.
