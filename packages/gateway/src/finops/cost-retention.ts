// Phase 10 FinOps: the daily retention pass over `cost_allocation` rows (OR-FO-5, 400 days).
//
// Confined by static rule D48 (no network, no connector, no model). It is a sidecar with its own
// `db`, like `startCuSnapshotRetention`, because a syncable context cannot list rows. Deletion goes
// through `deleteItemByPrimaryKey`, the function `deleteItemByServiceExternal` itself calls, so the
// graph cleanup stays on one path. `cost_recommendation` rows are not pruned by age.
import type { Database } from "bun:sqlite";
import { deleteItemByPrimaryKey } from "../index/item-store.ts";
import { COST_ALLOCATION_TYPE, COST_SERVICE_IDS, DAY_MS } from "./cost-item-contract.ts";

export const COST_PRUNE_INTERVAL_MS = DAY_MS;
const BATCH = 1000;

export interface PruneCostRowsOptions {
  readonly retainDays: number;
  readonly nowMs: number;
  /** Rows deleted per transaction; defaults to 1000. */
  readonly batch?: number;
  /** The delete chokepoint; injectable so a test can spy on it. */
  readonly deleteItem?: (db: Database, primaryKey: string) => void;
}

/** Delete `cost_allocation` rows whose day ended before `now - retainDays`; returns how many. */
export function pruneCostRows(db: Database, opts: PruneCostRowsOptions): number {
  if (opts.retainDays <= 0) {
    return 0;
  }
  const cutoff = opts.nowMs - opts.retainDays * DAY_MS;
  const batch = opts.batch ?? BATCH;
  const del = opts.deleteItem ?? deleteItemByPrimaryKey;
  const marks = COST_SERVICE_IDS.map(() => "?").join(", ");
  const select = db.query(
    `SELECT id FROM item
      WHERE type = ? AND service IN (${marks})
        AND json_extract(metadata, '$.periodEndMs') < ?
      LIMIT ?`,
  );
  let total = 0;
  for (;;) {
    const rows = select.all(COST_ALLOCATION_TYPE, ...COST_SERVICE_IDS, cutoff, batch) as {
      id: string;
    }[];
    if (rows.length === 0) {
      return total;
    }
    db.transaction(() => {
      for (const row of rows) {
        del(db, row.id);
      }
    })();
    total += rows.length;
  }
}

export interface StartFinopsRetentionOptions {
  readonly retainDays: number;
  readonly nowMs?: () => number;
  /** Test seam: the interval between ticks. */
  readonly intervalMs?: number;
  /** Test seam: replaces {@link pruneCostRows}. */
  readonly prune?: (db: Database, opts: PruneCostRowsOptions) => number;
}

export interface FinopsRetentionHandle {
  stop(): void;
}

/**
 * Prune once at boot, then every 24 h. Each tick is isolated: a thrown prune never escapes and the
 * next tick still runs. Push `stop` onto the sidecar stop list.
 */
export function startFinopsRetention(
  db: Database,
  opts: StartFinopsRetentionOptions,
): FinopsRetentionHandle {
  const clock = opts.nowMs ?? Date.now;
  const prune = opts.prune ?? pruneCostRows;
  const tick = (): void => {
    try {
      prune(db, { retainDays: opts.retainDays, nowMs: clock() });
    } catch {
      // Best-effort maintenance: never crash the gateway.
    }
  };
  tick();
  const timer = setInterval(tick, opts.intervalMs ?? COST_PRUNE_INTERVAL_MS);
  return { stop: () => clearInterval(timer) };
}
