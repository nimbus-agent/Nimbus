# Plan Review: Ticket Depth (Jira + Linear) Implementation Plan

This plan review covers comments, suggestions, and potential edge-case checks for the implementation steps outlined in the plan.

---

## 1. Concurrency and Transient Scheduler State

### Feedback
The plan introduces `historyFloors` as an in-memory `Map` inside `SyncScheduler`.
- **Transient State:** As noted, an in-memory map means a restart will drop a pending backfill. Since `rebody` is a CLI/IPC-triggered manual operation, this is acceptable and keeps the implementation simple.
- **Failures and Retries:** On `RateLimitError` or other temporary failures, the floor is kept. However, on success, the floor is deleted:
  ```ts
  this.historyFloors.delete(job.serviceId);
  ```
  If a sync succeeds but is interrupted midway (e.g. CLI client aborts or network disconnects but the scheduler task finishes successfully), the floor will be deleted. This is correct because the sync did complete successfully on the backend, meaning the watermark was updated.

---

## 2. Parameter Strictness in SQLite Queries

### Suggestion
In Task 6, `buildTargetServicesSql` changes its signature to return `params: Array<string | number>` instead of `string[]`. 
Ensure that any callers of `buildTargetServicesSql` (like `resolveTargetServices` or test mocks) do not assume `params` is strictly an array of strings (`string[]`). In the current codebase, `params` is passed via spread `...params` to `db.query(sql).all()`, which is safe under TypeScript strict type-checking, but verifying this in the test files is advised.

---

## 3. Jira Canceled Mapping and Future Drift

### Feedback
The plan states:
> "Jira folds 'Won't Do' / 'Canceled' resolutions into `done`; the distinction lives in `fields.resolution`, which the sync does not fetch. So `canceled` is unreachable on Jira by construction, not by omission."

This is a good, pragmatic constraint to keep the PR scope limited. However, we should be aware that if a future PR (like D2 or D3) starts fetching resolution data or fields, this mapping will need to be re-evaluated. The regression test `jira never yields canceled - it folds Won't Do into done` is highly valuable for catching this potential drift early.

---

## 4. Input Bounds for `--since`

### Suggestion
While the CLI validates that `--since` is a positive integer, there is no realistic upper bound check (e.g., if a user requests `--since 100000`, which is ~273 years). While not a functional blocker, it might be worth logging a warning if the number of days exceeds a reasonable threshold (e.g., 3650 days / 10 years) to protect against accidental fat-finger typos that could lead to extremely long cold-start requests.
