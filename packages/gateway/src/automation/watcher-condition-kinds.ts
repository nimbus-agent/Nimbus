/**
 * The single source of truth for which watcher conditions the engine can evaluate.
 *
 * `watcher-engine.ts` builds its item query from this table, and `ipc/automation-rpc.ts`
 * rejects a `watcher.create` whose condition type is absent from it. Keeping both readers on
 * one table is the point: a creation path that accepted a condition the engine cannot evaluate
 * would produce a watcher that is silently inert forever.
 *
 * `extraSql` is a COMPILE-TIME CONSTANT fragment ANDed into that query. It is never derived from
 * a row, a user, or an IPC parameter, and must never become so — every value in the query is a
 * bound parameter (I9).
 */
export type WatcherConditionKind = {
  /** The value stored in `watcher.condition_type`. */
  readonly conditionType: string;
  /** The `item.type` this condition observes. */
  readonly itemType: string;
  /** Constant SQL ANDed into the item query, or "" for none. */
  readonly extraSql: string;
};

export const WATCHER_CONDITION_KINDS: readonly WatcherConditionKind[] = [
  // Preserved as-is. NOTE: no connector indexes `item.type = 'alert'` today, so this condition
  // cannot currently fire. That is the pre-existing state, recorded rather than silently fixed.
  { conditionType: "alert_fired", itemType: "alert", extraSql: "" },
  // PagerDuty indexes `type: "incident"` (connectors/pagerduty-sync.ts).
  { conditionType: "incident_opened", itemType: "incident", extraSql: "" },
  // CI-annotated deployments only: `deployment/annotate.ts` writes metadata.conclusion. Vercel
  // records its outcome under metadata.state, and Prefect indexes deployment DEFINITIONS with no
  // outcome at all, so neither matches. Keyed on the presence of the conclusion value rather than
  // on a producer name, so a new producer that adopts the same shape works without a code change.
  //
  // `json_valid(metadata)` is LOAD-BEARING, not defensive noise: SQLite's json_extract RAISES
  // "malformed JSON" on a non-JSON TEXT value, and that exception would propagate out of
  // evaluateOneWatcher through the whole evaluateWatchersAfterSync loop — killing evaluation for
  // EVERY watcher, not just this one. (A NULL metadata is safe on its own; an empty string or
  // plain text is not.) Every production writer stringifies today, so this guards a migration or a
  // future writer, at the cost of one cheap call.
  //
  // Extending to Vercel later means matching a DIFFERENT key with a different vocabulary
  // (metadata.state = 'ERROR'). A single extraSql string can express that as an OR, but the moment
  // a second shape lands, prefer widening this type to hold several predicates per kind over
  // growing one unreadable SQL string.
  {
    conditionType: "deploy_failed",
    itemType: "deployment",
    extraSql: "AND json_valid(metadata) AND json_extract(metadata, '$.conclusion') = 'failure'",
  },
];

export function watcherConditionKind(conditionType: string): WatcherConditionKind | undefined {
  return WATCHER_CONDITION_KINDS.find((k) => k.conditionType === conditionType);
}

export function isKnownWatcherConditionType(conditionType: string): boolean {
  return watcherConditionKind(conditionType) !== undefined;
}
