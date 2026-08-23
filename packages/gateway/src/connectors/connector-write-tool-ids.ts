/**
 * Write tool ids routed through the connector consent kit but NOT dispatchable from the gateway.
 *
 * Deliberately separate from `CONNECTOR_WRITES`. That registry is a 1:1 `actionType` ↔ `toolId` map
 * driving `connector-write-dispatch.ts`; these tools have no dispatch path, and inventing rows for
 * them would put fictional routing into a real routing table. I26's predicate asks only "is this
 * tool id a write?", which a set answers exactly.
 *
 * Grows one wave at a time as connectors migrate to `registerWriteTool`. When a tool gains a
 * dispatch path it graduates to a `ConnectorWrite` row and leaves this set — the registry test
 * asserts the two never overlap.
 */
export const MIGRATED_WRITE_TOOL_IDS: ReadonlySet<string> = new Set([
  // github — Part 1 (#1318)
  "github_pr_merge",
  "github_pr_close",
  "github_issue_create",
  "github_branch_delete",
  "github_tag_create",
]);
