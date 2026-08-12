# GitHub Contribution Depth Design Review

## Open Questions & Risks

1. **GitHub Timeline API Limitations vs. Incremental Accumulation**
   - The spec notes: "incremental accumulation works, retroactive backfill does not" due to the 30-day/300-event ceiling.
   - **Question**: When a user goes OOO or shuts down Nimbus for >30 days, is there any warning or detection mechanism? If they miss the 30-day window, will Nimbus silently omit reviews that occurred during that period, leading to silent data gaps?
   - **Suggestion**: In the connector status or next-sync output, if `last_synced_at` (or equivalent sync high-water mark) is older than 30 days, log a warning or suggest triggering the search-based backfill (`nimbus index backfill --service github`). **[HISTORICAL — not adopted: `nimbus index backfill` was never shipped and does not exist in the CLI; this PR's own tests assert no gap note may reference it. Preserved verbatim as the question was originally asked.]**

2. **Differentiating PR Authorship from PR Review in Context Retrieval**
   - Under § 4 ("Chosen — reuse `upsertPr` verbatim"), colleague PR descriptions are fully indexed.
   - **Question**: When an agent runs a prompt or queries semantic search for "my code changes" or "PRs I worked on", does the system have a robust way to filter out PRs where the user was *only* a reviewer, to avoid mixing colleague code context with own code context?
   - **Suggestion**: Ensure that the queries in the agent layer explicitly filter by relations (`author_id` vs `--reviewed-->`) rather than just pulling all indexed `github:pr` items indiscriminately.

3. **`CROSS_ITEM_RELATION_TYPES` Leakage / Staleness**
   - Under § 5.F, a dismissed or deleted review leaves a stale edge because no retirement mechanism is implemented.
   - **Question**: If a review is dismissed and then a new review is submitted, will we display duplicate/stale review relationships in the self-advocacy brief?
   - **Suggestion**: In the backfill (PR 2) or when processing a full list, we should consider a basic pruning/reconciliation step (e.g., delete all `reviewed` edges for a specific PR and re-insert current ones) to avoid stale duplicate edges.

4. **Rate Limit Separation & Throttling**
   - The backfill will run on `github_search` rate-limit bucket.
   - **Question**: How does the rate limiter handle sub-division of buckets or secondary limits (such as GitHub's abuse detection limits for search)?
   - **Suggestion**: Implement an adaptive backoff delay specifically for the search backfill loop (e.g., sleep between search queries) rather than relying solely on the static rate limiter.

## Suggestions for PR 1 Implementation Plan

- **Explicit Validation of `resolveGithubActorPersonId`**: Add a test case in `graph-populator-reviews.test.ts` where a third-party reviewer is resolved, verifying that they map to a distinct Person entity from the PR author.
- **Stats-missing Metric**: Log a metric or trace when stats are missing, so we can monitor how quickly the enrich queue catching up with historical PRs.
