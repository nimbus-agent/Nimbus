import type { Database } from "bun:sqlite";

import { pruneIncidentRecordsWithBriefs } from "./incident-erasure.ts";

/**
 * The daily incident-record prune (Phase 10 IC3, `[incident] retention_days`): one pass at boot and one per
 * 24 hours, the sibling of `index/item-history-retention.ts`. A pass deletes records older than the cutoff in
 * batches of 500, each batch together with the pushed briefs built from it, so effective brief retention is the
 * shorter of the two settings. A pass never runs inside a sync pass; this module imports nothing from `sync/` or
 * `connectors/`. A demo-rooted gateway runs it against its own database.
 */

export const INCIDENT_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type IncidentRetentionTimer = { readonly clear: () => void };

export type StartIncidentRetentionOptions = {
  /** Read EVERY tick, so an edited `nimbus.toml` applies without a restart. */
  readonly retentionDays: () => number;
  readonly nowMs?: () => number;
  /** Test seams. */
  readonly batchSize?: number;
  readonly maxBatches?: number;
  readonly setTimer?: (fn: () => void, ms: number) => IncidentRetentionTimer;
  readonly onError?: (err: unknown) => void;
};

export type IncidentRetentionHandle = {
  readonly stop: () => void;
  /** Resolves when the pass in flight (if any) has finished. */
  readonly idle: () => Promise<void>;
};

function defaultSetTimer(fn: () => void, ms: number): IncidentRetentionTimer {
  const t = setInterval(fn, ms);
  return { clear: () => clearInterval(t) };
}

export function startIncidentRetention(
  db: Database,
  opts: StartIncidentRetentionOptions,
): IncidentRetentionHandle {
  const clock = opts.nowMs ?? Date.now;
  const setTimer = opts.setTimer ?? defaultSetTimer;
  let inFlight: Promise<void> | undefined;
  const tick = (): void => {
    if (inFlight !== undefined) return;
    inFlight = Promise.resolve()
      .then(() => {
        pruneIncidentRecordsWithBriefs(
          db,
          clock() - opts.retentionDays() * DAY_MS,
          opts.batchSize,
          opts.maxBatches,
        );
      })
      .catch((err: unknown) => {
        // Best-effort maintenance: never crash the gateway.
        opts.onError?.(err);
      })
      .finally(() => {
        inFlight = undefined;
      });
  };
  tick();
  const timer = setTimer(tick, INCIDENT_PRUNE_INTERVAL_MS);
  return {
    stop: () => timer.clear(),
    idle: async () => inFlight,
  };
}
