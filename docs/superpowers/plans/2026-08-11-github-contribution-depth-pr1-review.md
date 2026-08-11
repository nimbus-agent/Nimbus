# GitHub Contribution Depth PR1 Implementation Plan Review

## Open Questions & Risks

1. **Step-by-Step Execution Verification**
   - The plan is very structured with `- [ ]` checkboxes and detailed code snippets.
   - **Question**: When executing these tasks, what if the existing types in `relationship-graph.ts` or other files slightly differ in structure?
   - **Suggestion**: Before editing each file, print or view the current state of that specific section (e.g. `relationship-graph.ts` line ranges) to ensure drop-in replacement matches.

2. **Idempotence & Edge Survival Test Case**
   - In Task 1 Step 1, the test `"a reviewed edge survives the PR being re-populated"` is highly critical.
   - **Suggestion**: Ensure that we verify that the relationship graph actually populates the database correctly before and after the `seedPr` (re-sync) execution. 

3. **`detectMissingRelationEmit` Message Matching**
   - In Task 2 and Task 3, `detectMissingRelationEmit` is invoked with a custom description: `"Reviews are indexed from the GitHub events feed — sync the connector, or run nimbus index backfill --service github for history."`.
   - **Question**: Are there existing tests in the test suite (like `expert.test.ts` or `why.test.ts`) that assert on the exact error/gap message structure?
   - **Suggestion**: If so, we should update those tests to match this new text exactly, otherwise the test suite might break due to message mismatches.

4. **Coverage Floor Gaps**
   - The plan states: "Neither `github-sync.ts` nor `graph-populator.ts` appears in `docs/structure-audit/coverage-baseline.json`".
   - **Question**: Will the changes in `github-sync.ts` (especially the parsing and fallback logic) reduce the branch coverage below the 80% floor?
   - **Suggestion**: Make sure the tests added in Task 4 explicitly exercise:
     - A malformed review event payload (to cover error handling branches).
     - Events missing stats vs events containing stats.
     - Rate-limit handling when `retry-after` header is present.

## Code Improvement Suggestions

- **Task 4 (processEvent payload check)**: In Task 4, when handling the `PullRequestReviewEvent` event, ensure we safely access properties (e.g., `payload?.review` or `payload?.pull_request`) using optional chaining or robust guards to prevent runtime `Cannot read properties of undefined` crashes on unexpected payloads.
- **Dry-run Search Backfill (PR 2 Prep)**: For Task 7's `retry-after` logic, document that `github_search` will use the same parser helper functions to ensure consistency between PR1 and PR2.
