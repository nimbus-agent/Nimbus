import type { Database } from "bun:sqlite";

import { pruneSchemaHistory } from "./schema-history.ts";

/**
 * The daily `schema_history` prune (`[index] schema_history_retention_days`), run by the same daily tick as
 * the `item_history` prune (`startItemHistoryRetention`). Observations are rare (a row only
 * when a table's column set changes), so a pass is a few batched statements that yield to the event loop between
 * batches. It never runs inside a sync, imports nothing from `sync/` or `connectors/`, and runs on a demo
 * gateway too (its database is its own, I41). The newest observation of every table survives any cutoff.
 */

export const SCHEMA_HISTORY_PRUNE_BATCH = 2000;
export const SCHEMA_HISTORY_PRUNE_MAX_BATCHES = 20;
export const SCHEMA_HISTORY_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** One pass: batches until one is not full, or the cap is reached. Returns the rows deleted. */
export async function runSchemaHistoryPrune(
  db: Database,
  opts: {
    readonly retentionDays: number;
    readonly nowMs: number;
    readonly yieldToEventLoop: () => Promise<void>;
  },
): Promise<number> {
  const cutoffMs = opts.nowMs - opts.retentionDays * DAY_MS;
  let deleted = 0;
  for (let b = 0; b < SCHEMA_HISTORY_PRUNE_MAX_BATCHES; b++) {
    const r = pruneSchemaHistory(db, {
      cutoffMs,
      batchSize: SCHEMA_HISTORY_PRUNE_BATCH,
      maxBatches: 1,
    });
    deleted += r.deleted;
    if (!r.more) break;
    await opts.yieldToEventLoop();
  }
  return deleted;
}
