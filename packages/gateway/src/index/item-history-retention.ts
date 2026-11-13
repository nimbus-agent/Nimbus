import type { Database } from "bun:sqlite";

import { pruneItemHistory } from "./item-history.ts";

/**
 * The daily `item_history` prune (Phase 10 IC1, `[index] history_retention_days`). The sibling of
 * `db/tool-call-log-retention.ts`, with one difference: the table can hold millions of rows after a long
 * outage of the prune, so each pass deletes in batches of 5,000 (one indexed statement each) and yields to
 * the event loop between batches instead of blocking it in one statement.
 *
 * A pass never runs inside a sync: this module imports nothing from `sync/` or `connectors/`. Demo-rooted
 * gateways (I41) run it too: their database is their own; there is no network, vault or model here.
 */

export const ITEM_HISTORY_PRUNE_BATCH = 5000;
export const ITEM_HISTORY_PRUNE_MAX_BATCHES = 40;
export const ITEM_HISTORY_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ItemHistoryPruneRun = {
  readonly deleted: number;
  readonly batches: number;
  readonly more: boolean;
};

/** One pass: batches until a batch is not full, or `maxBatches` is reached. */
export async function runItemHistoryPrune(
  db: Database,
  opts: {
    readonly retentionDays: number;
    readonly nowMs: number;
    readonly yieldToEventLoop: () => Promise<void>;
    readonly batchSize?: number;
    readonly maxBatches?: number;
  },
): Promise<ItemHistoryPruneRun> {
  const cutoffMs = opts.nowMs - opts.retentionDays * DAY_MS;
  const batchSize = opts.batchSize ?? ITEM_HISTORY_PRUNE_BATCH;
  const maxBatches = opts.maxBatches ?? ITEM_HISTORY_PRUNE_MAX_BATCHES;
  let deleted = 0;
  let batches = 0;
  let more = false;
  while (batches < maxBatches) {
    const r = pruneItemHistory(db, { cutoffMs, batchSize, maxBatches: 1 });
    batches += 1;
    deleted += r.deleted;
    more = r.more;
    if (!more) break;
    if (batches < maxBatches) await opts.yieldToEventLoop();
  }
  return { deleted, batches, more };
}

export type ItemHistoryRetentionTimer = { readonly clear: () => void };

export type StartItemHistoryRetentionOptions = {
  /** Read EVERY tick, so an edited `nimbus.toml` applies without a restart. */
  readonly retentionDays: () => number;
  readonly nowMs?: () => number;
  readonly yieldToEventLoop?: () => Promise<void>;
  /** Test seams: the per-batch row count and the per-pass batch cap. */
  readonly batchSize?: number;
  readonly maxBatches?: number;
  /** Repeating timer factory; injected in tests. */
  readonly setTimer?: (fn: () => void, ms: number) => ItemHistoryRetentionTimer;
};

export type ItemHistoryRetentionHandle = {
  readonly stop: () => void;
  /** Resolves when the pass in flight (if any) has finished. For tests and orderly shutdown. */
  readonly idle: () => Promise<void>;
};

function defaultYield(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function defaultSetTimer(fn: () => void, ms: number): ItemHistoryRetentionTimer {
  const t = setInterval(fn, ms);
  return { clear: () => clearInterval(t) };
}

/**
 * Starts one pass now (NOT awaited: boot must not block on it), then one every 24 hours. A pass that is
 * still running when the next tick fires is not doubled. A throwing pass never escapes.
 */
export function startItemHistoryRetention(
  db: Database,
  opts: StartItemHistoryRetentionOptions,
): ItemHistoryRetentionHandle {
  const clock = opts.nowMs ?? Date.now;
  const yieldToEventLoop = opts.yieldToEventLoop ?? defaultYield;
  const setTimer = opts.setTimer ?? defaultSetTimer;
  let inFlight: Promise<void> | undefined;
  let stopped = false;
  const tick = (): void => {
    if (inFlight !== undefined) return;
    inFlight = (async () => {
      try {
        // A pass is bounded; a backlog larger than one pass is drained by further passes right away
        // (yielding between them), not left for the next day's tick.
        let more = true;
        while (more && !stopped) {
          const run = await runItemHistoryPrune(db, {
            retentionDays: opts.retentionDays(),
            nowMs: clock(),
            yieldToEventLoop,
            ...(opts.batchSize === undefined ? {} : { batchSize: opts.batchSize }),
            ...(opts.maxBatches === undefined ? {} : { maxBatches: opts.maxBatches }),
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
  const timer = setTimer(tick, ITEM_HISTORY_PRUNE_INTERVAL_MS);
  return {
    stop: () => {
      stopped = true;
      timer.clear();
    },
    idle: async () => inFlight,
  };
}
