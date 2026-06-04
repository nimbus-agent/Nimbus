import type { Database } from "bun:sqlite";

import { appendAuditEntry } from "./audit-chain.ts";
import { dbRun } from "./write.ts";

const DAY_MS = 86_400_000;

/** Daily cadence for the retention job. */
export const TOOL_CALL_LOG_PRUNE_INTERVAL_MS = DAY_MS;

export interface PruneToolCallLogOptions {
  /** From `[audit].tool_call_log_retention_days`. 0 disables pruning. */
  retentionDays: number;
  /** Injected clock (epoch ms) for deterministic tests. */
  nowMs: number;
}

function toolCallLogExists(db: Database): boolean {
  const row = db
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tool_call_log'")
    .get() as { 1: number } | null;
  return row !== null;
}

/**
 * Delete tool_call_log rows older than the retention window and, when any were
 * removed, append ONE `tool_call_log.pruned` entry to the chained audit_log.
 * The audit_log chain is only appended to — never rewritten. Returns the number
 * of deleted rows.
 */
export function pruneToolCallLog(db: Database, opts: PruneToolCallLogOptions): number {
  if (opts.retentionDays <= 0) {
    return 0;
  }
  if (!toolCallLogExists(db)) {
    return 0;
  }
  const cutoffMs = opts.nowMs - opts.retentionDays * DAY_MS;

  let deleted = 0;
  db.transaction(() => {
    const res = dbRun(db, "DELETE FROM tool_call_log WHERE called_at < ?", [cutoffMs]);
    deleted = Number(res.changes);
    if (deleted > 0) {
      appendAuditEntry(db, {
        actionType: "tool_call_log.pruned",
        hitlStatus: "not_required",
        actionJson: JSON.stringify({
          deleted_count: deleted,
          retention_days: opts.retentionDays,
          cutoff_ms: cutoffMs,
        }),
        timestamp: opts.nowMs,
      });
    }
  })();
  return deleted;
}

export interface StartToolCallLogRetentionOptions {
  retentionDays: number;
  /** Clock source; defaults to Date.now. Injected in tests. */
  nowMs?: () => number;
}

export interface ToolCallLogRetentionHandle {
  stop(): void;
}

/**
 * Run the retention prune once immediately, then every 24h. Each tick is
 * isolated (a thrown prune never escapes). Returns a stop handle to clear the
 * timer; push it onto the sidecar stop list. When retention is disabled
 * (retentionDays <= 0) no timer is created and the handle is a no-op.
 */
export function startToolCallLogRetention(
  db: Database,
  opts: StartToolCallLogRetentionOptions,
): ToolCallLogRetentionHandle {
  const clock = opts.nowMs ?? Date.now;
  if (opts.retentionDays <= 0) {
    return { stop: () => {} };
  }
  const tick = (): void => {
    try {
      pruneToolCallLog(db, { retentionDays: opts.retentionDays, nowMs: clock() });
    } catch {
      // Best-effort maintenance — never crash the scheduler.
    }
  };
  tick();
  const timer = setInterval(tick, TOOL_CALL_LOG_PRUNE_INTERVAL_MS);
  return { stop: () => clearInterval(timer) };
}
