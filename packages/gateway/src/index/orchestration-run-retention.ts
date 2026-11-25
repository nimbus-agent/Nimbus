import type { Database } from "bun:sqlite";

import { deleteItemByPrimaryKey } from "./item-store.ts";

/**
 * The daily prune of orchestration RUN rows (`airflow:dag_run`, `dagster:job_run`, `prefect:flow_run`),
 * `[orchestration] run_retention_days`. A run is deleted when it ended (else started, else was last modified)
 * before `now - retentionDays`. ONLY those three (service, type) pairs are touched: the DAG, job and
 * deployment items they belong to are never selected. Deletion goes through `deleteItemByPrimaryKey`, the one
 * index delete path (graph and chunk cleanup stay on it), in bounded batches that yield to the event loop.
 *
 * Self-contained on purpose: it imports nothing from `sync/` or `connectors/`, and shares no helper with the
 * other retention passes. Demo-rooted gateways run it too (their database is their own; no network here).
 */

export const RUN_PRUNE_BATCH = 500;
export const RUN_PRUNE_MAX_BATCHES = 40;
export const RUN_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type RunPrune = { readonly deleted: number; readonly more: boolean };

/** One pass: batches until a batch is not full or `maxBatches` is reached (`more` then says rows remain). */
export async function pruneOrchestrationRuns(
  db: Database,
  opts: {
    readonly retentionDays: number;
    readonly nowMs: number;
    readonly yieldToEventLoop: () => Promise<void>;
    readonly batchSize?: number;
    readonly maxBatches?: number;
  },
): Promise<RunPrune> {
  const cutoff = opts.nowMs - opts.retentionDays * DAY_MS;
  const batchSize = opts.batchSize ?? RUN_PRUNE_BATCH;
  const maxBatches = opts.maxBatches ?? RUN_PRUNE_MAX_BATCHES;
  // lane-census: scope=dag_run,job_run,flow_run service=airflow,dagster,prefect
  const select = db.query(
    `SELECT id FROM (
       SELECT id, service, type,
              COALESCE(
                CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.end_ms') END,
                CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.start_ms') END,
                modified_at
              ) AS at_ms
         FROM item
        WHERE (service = 'airflow' AND type = 'dag_run')
           OR (service = 'dagster' AND type = 'job_run')
           OR (service = 'prefect' AND type = 'flow_run'))
      WHERE at_ms < ?
      LIMIT ?`,
  );
  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const rows = select.all(cutoff, batchSize) as { id: string }[];
    if (rows.length === 0) return { deleted, more: false };
    db.transaction(() => {
      for (const r of rows) deleteItemByPrimaryKey(db, r.id);
    })();
    deleted += rows.length;
    if (rows.length < batchSize) return { deleted, more: false };
    await opts.yieldToEventLoop();
  }
  return { deleted, more: true };
}

export type RunRetentionHandle = {
  readonly stop: () => void;
  /** Resolves when the pass in flight (if any) has finished. For tests and orderly shutdown. */
  readonly idle: () => Promise<void>;
};

function defaultYield(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * One pass now (NOT awaited: boot must not block on it), then one every 24 hours. `retentionDays` is read
 * every tick, so an edited `nimbus.toml` applies without a restart. A pass still running is not doubled; a
 * throwing pass never escapes.
 */
export function startOrchestrationRunRetention(
  db: Database,
  opts: {
    readonly retentionDays: () => number;
    readonly nowMs?: () => number;
    readonly yieldToEventLoop?: () => Promise<void>;
    readonly intervalMs?: number;
  },
): RunRetentionHandle {
  const clock = opts.nowMs ?? Date.now;
  const yieldToEventLoop = opts.yieldToEventLoop ?? defaultYield;
  let inFlight: Promise<void> | undefined;
  let stopped = false;
  const tick = (): void => {
    if (inFlight !== undefined) return;
    inFlight = (async () => {
      try {
        let more = true;
        while (more && !stopped) {
          const run = await pruneOrchestrationRuns(db, {
            retentionDays: opts.retentionDays(),
            nowMs: clock(),
            yieldToEventLoop,
          });
          more = run.more;
          if (more) await yieldToEventLoop();
        }
      } catch {
        // Best-effort maintenance: never crash the gateway.
      }
    })().finally(() => {
      inFlight = undefined;
    });
  };
  tick();
  const timer = setInterval(tick, opts.intervalMs ?? RUN_PRUNE_INTERVAL_MS);
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    idle: async () => inFlight,
  };
}
