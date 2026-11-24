import type { Database } from "bun:sqlite";

import { deleteItemByPrimaryKey } from "./item-store.ts";

/**
 * The retention pass over dbt test results (Data Incident Brief input, `[index] dbt_test_retention_days`):
 * `dbt` `data_quality_test` rows whose run finished (`modified_at`) before the cutoff are deleted through
 * `deleteItemByPrimaryKey`, the index's normal delete path, so FTS, embeddings and graph entities go with them.
 * Only service `dbt` is touched: a Monte Carlo, Bigeye or Great Expectations `data_quality_test` is never
 * selected. Rows go in bounded batches (one transaction each) and the pass yields to the event loop between
 * them. It runs from the daily item-history tick (`item-history-retention.ts`).
 */

export const DBT_TEST_PRUNE_BATCH = 500;
export const DBT_TEST_PRUNE_MAX_BATCHES = 40;
const DAY_MS = 24 * 60 * 60 * 1000;

export type DbtTestPruneRun = { readonly deleted: number; readonly more: boolean };

export async function pruneDbtTests(
  db: Database,
  opts: {
    readonly retentionDays: number;
    readonly nowMs: number;
    readonly yieldToEventLoop: () => Promise<void>;
    readonly batchSize?: number;
    readonly maxBatches?: number;
  },
): Promise<DbtTestPruneRun> {
  const cutoff = opts.nowMs - opts.retentionDays * DAY_MS;
  const batchSize = opts.batchSize ?? DBT_TEST_PRUNE_BATCH;
  const maxBatches = opts.maxBatches ?? DBT_TEST_PRUNE_MAX_BATCHES;
  const select = db.query(
    `SELECT id FROM item
      WHERE service = 'dbt' AND type = 'data_quality_test' AND modified_at < ?
      LIMIT ?`,
  );
  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const rows = select.all(cutoff, batchSize) as { id: string }[];
    if (rows.length === 0) return { deleted, more: false };
    db.transaction(() => {
      for (const row of rows) deleteItemByPrimaryKey(db, row.id);
    })();
    deleted += rows.length;
    if (rows.length < batchSize) return { deleted, more: false };
    await opts.yieldToEventLoop();
  }
  return { deleted, more: true };
}
