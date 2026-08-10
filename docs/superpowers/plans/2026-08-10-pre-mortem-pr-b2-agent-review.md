# pre-mortem PR B2 — Agent Implementation Plan Review & Feedback

## Open Questions

1. **Un-suppressing Deliberately Deleted Watchers:**
   - **Context:** The plan states: *"...an id present in that table but ABSENT from `watcher` was deliberately deleted and is never re-created; it is reported as `suppressed` so the brief can list it with the command to un-suppress."*
   - **Question:** What is the specific CLI command or action for a user to "un-suppress" a deleted proposal? Since the watcher row itself has been deleted, a simple `nimbus watch resume <id>` will not work because the row is gone from the `watcher` table. Do we need to expose a command/flag like `nimbus pre-mortem <epic-ref> --repropose` (which would delete the tombstone from `premortem_watcher_proposal` and insert it back into `watcher`), or should the brief instruct them to manually edit the SQLite database/run a specific SQL command? We should clarify this UX.

2. **IDF Scoring with Single-Epic/Homogeneous History:**
   - **Context:** Score is calculated as `log(N / epicsTouchingService)`.
   - **Question:** If the scanned history is very small or contains only a single candidate closed epic ($N = 1$), any service touching it will have `epicsTouchingService = 1`, making the weight $\log(1/1) = 0$ (scoring all candidates 0). Similarly, if a service touches every candidate, its weight becomes 0.
   - While the plan notes this prevents ubiquitous services from skewing metrics, should we add a smoothing factor/constant to ensure rare services on small histories still have distinct, non-zero weights (e.g., using a standard smoothed IDF formulation like $\log(\frac{N + 1}{\text{epicsTouchingService}}) + 1$), or is $\log(N / \text{epicsTouchingService})$ strictly required?

## Suggestions & Improvements

1. **Transactional Integrity for Watcher Proposals:**
   - **Suggestion:** In `watcher-proposals.ts`, the proposal inserts into both `watcher` and `premortem_watcher_proposal` tables. We should run these updates inside a single database transaction (`db.transaction(...)` or similar Bun SQLite wrapper) to guarantee atomic writes and avoid half-inserted states if one query fails.

2. **Handling Clock Skew in Cycle Time Expectation:**
   - **Suggestion:** The boundary for the cycle time expectation reads: `nowMs - targetCreatedAtMs < 86_400_000`. If local clock skew causes `targetCreatedAtMs` to be slightly in the future (or exact match), the difference could be negative or zero. Ensure the check handles this gracefully: `nowMs - targetCreatedAtMs <= 86_400_000` (or `nowMs - targetCreatedAtMs < DAY || targetCreatedAtMs > nowMs`).

3. **Safe JSON Parsing and Extracts in Cohort Selection:**
   - **Suggestion:** When selecting candidates in `cohort.ts`, ensure that `json_valid(metadata)` guards the `json_extract` checks directly in the `WHERE` clause:

     ```sql
     SELECT ... FROM item
     WHERE json_valid(metadata)
       AND json_extract(metadata, '$.issue_type') = 'Epic'
       AND json_extract(metadata, '$.status_category') IN ('done', 'canceled')
     ```

     This prevents queries from throwing errors if any malformed or null metadata entries are present.
