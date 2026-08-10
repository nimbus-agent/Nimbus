# pre-mortem PR B1 — Watcher Conditions Plan Review & Feedback

## Open Questions

1. **Vercel deploy failure parsing in future:**
   - The plan states: `deploy_failed` covers CI-annotated deployments only.
   - *Question:* In the condition table (`watcher-condition-kinds.ts`), we write a static `extraSql: "AND json_extract(metadata, '$.conclusion') = 'failure'"`. If we ever want to support Vercel (which uses `state = 'ERROR'`), will `extraSql` be sufficient, or will we need a more expressive schema/mapping? Should we mention this limitation clearly in the table module comments to guide future developers?

2. **Graph Predicates type safety:**
   - *Question:* Since `watcher.create` now checks `isKnownWatcherConditionType`, does this validation run before or after the graph predicate validation? We should make sure the ordering of exceptions is consistent in `ipc/automation-rpc.ts`.

## Suggestions & Improvements

1. **Refined SQLite JSON Extract Safety:**
   - In `deploy_failed`'s extraSql: `AND json_extract(metadata, '$.conclusion') = 'failure'`.
   - *Suggestion:* In SQLite, `json_extract` can throw an error if `metadata` is not valid JSON or is null. If there are old rows where `metadata` is a plain string or empty/null, this might cause queries to fail. We should ensure the SQL is safe, for example: `AND json_valid(metadata) AND json_extract(metadata, '$.conclusion') = 'failure'`.

2. **Verification of `deploy_failed` Metadata Field in CI:**
   - *Suggestion:* Double check if the key is `conclusion` or `result` in all CI-annotated deployment payloads (such as GitHub Actions or general webhooks). If `deployment/annotate.ts` indeed uses `conclusion`, then `$.conclusion` is correct.

3. **Pre-flight & Lint Checks for test templates:**
   - *Suggestion:* Make sure the newly added tests don't trigger any Biome/ESLint rules for unbound promises (especially since `dispatchAutomationRpc` is async and we use `await expect(...).rejects.toThrow()`).
