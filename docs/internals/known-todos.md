# Known TODOs

Concrete future tasks migrated from inline `TODO`/`FIXME` comments. Each entry cites the original source file:line and the date it was captured.

Stale or vague TODOs without a concrete task are deleted in Pass 3 with no migration.

## Entries

- `packages/gateway/src/connectors/lazy-mesh/user-mcp.ts:13` (2026-05-28): Thread the registry-stored user-MCP manifest into `MeshSpawnContext` and apply it in place of the conservative `userMcpDefaultManifest()` default-deny lookup — Task 15 + post-PR 1 follow-up. Until then the conservative default-deny sandbox manifest is applied to all user MCPs regardless of their declared permissions.
- `packages/gateway/test/unit/connectors/bitbucket-sync.test.ts:375` (2026-05-28): `itemsUpserted` over-counts when a PR has a missing `id` field — `bitbucket-sync.ts` increments `upsertedDelta` unconditionally even when `upsertFromPullRequest()` returns early without writing a row. The test currently locks in the buggy count so any fix will trip the assertion; a follow-up issue should coordinate the counter fix with updating this assertion.
