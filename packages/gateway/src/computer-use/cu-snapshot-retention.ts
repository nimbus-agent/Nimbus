import type { Database } from "bun:sqlite";

import { pruneSnapshots } from "./cu-store.ts";

const DAY_MS = 86_400_000;

/**
 * Daily cadence for the retention job — the same cadence `db/tool-call-log-retention.ts` uses for
 * its neighbouring pass, kept identical rather than invented, per spec § 8.4.
 */
export const CU_SNAPSHOT_PRUNE_INTERVAL_MS = DAY_MS;

export interface PruneCuSnapshotsOptions {
  /** From `[computer_use] snapshot_retention_days`. 0 disables pruning. */
  retentionDays: number;
  /** Injected clock (epoch ms) for deterministic tests. */
  nowMs: number;
  /**
   * Injectable for tests so a call can be asserted by spy rather than only by DB effect;
   * defaults to the real `pruneSnapshots` from `cu-store.ts`.
   */
  prune?: (db: Database, cutoffMs: number) => void;
}

/**
 * Compute the retention cutoff from `retentionDays` and invoke the `cu-store.ts` prune
 * (spec § 8.4): NULL `dom_before`/`dom_after` for every `cu_action` row older than the window.
 * The `cu_action` row itself and its `audit_log` decision row are untouched — permanent, by
 * design — only the bulky replay body ages out. `retentionDays <= 0` disables pruning entirely,
 * mirroring `pruneToolCallLog`'s convention.
 */
export function pruneCuSnapshots(db: Database, opts: PruneCuSnapshotsOptions): void {
  if (opts.retentionDays <= 0) {
    return;
  }
  const cutoffMs = opts.nowMs - opts.retentionDays * DAY_MS;
  const prune = opts.prune ?? pruneSnapshots;
  prune(db, cutoffMs);
}

export interface StartCuSnapshotRetentionOptions {
  retentionDays: number;
  /** Clock source; defaults to Date.now. Injected in tests. */
  nowMs?: () => number;
}

export interface CuSnapshotRetentionHandle {
  stop(): void;
}

/**
 * Run the snapshot-retention prune once immediately, then every 24h — the same shape as
 * `startToolCallLogRetention`. Each tick is isolated (a thrown prune never escapes). Returns a
 * stop handle to clear the timer; push it onto the sidecar stop list. When retention is disabled
 * (`retentionDays <= 0`) no timer is created and the handle is a no-op.
 */
export function startCuSnapshotRetention(
  db: Database,
  opts: StartCuSnapshotRetentionOptions,
): CuSnapshotRetentionHandle {
  const clock = opts.nowMs ?? Date.now;
  if (opts.retentionDays <= 0) {
    return { stop: () => {} };
  }
  const tick = (): void => {
    try {
      pruneCuSnapshots(db, { retentionDays: opts.retentionDays, nowMs: clock() });
    } catch {
      // Best-effort maintenance — never crash the scheduler.
    }
  };
  tick();
  const timer = setInterval(tick, CU_SNAPSHOT_PRUNE_INTERVAL_MS);
  return { stop: () => clearInterval(timer) };
}
