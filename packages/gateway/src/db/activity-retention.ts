import type { Database } from "bun:sqlite";

import { dbRun } from "./write.ts";

const DAY_MS = 86_400_000;

/**
 * How long operational history is kept. These rows describe what the gateway did (a sync run's
 * counts and error text, a watcher's condition snapshot when it fired), not the user's data, and
 * nothing deleted them, so they grew by one row per sync run per connector for as long as the
 * install lived. 90 days is the `tool_call_log` default and covers every read of them: the
 * telemetry aggregate looks back seven days, `nimbus watcher history` reads the newest few.
 */
export const ACTIVITY_RETENTION_DAYS = 90;

/** Daily, like the `tool_call_log` job. */
export const ACTIVITY_PRUNE_INTERVAL_MS = DAY_MS;

/** Each table and the epoch-ms column its age is read from. Constant identifiers only (I9). */
const ACTIVITY_TABLES = [
  { table: "sync_telemetry", column: "started_at" },
  { table: "watcher_event", column: "fired_at" },
] as const;

function tableExists(db: Database, name: string): boolean {
  return (
    db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null
  );
}

/**
 * Delete activity rows older than `retentionDays`. Returns the count removed per table (absent
 * tables are skipped). `retentionDays <= 0` keeps everything.
 */
export function pruneActivityHistory(
  db: Database,
  opts: { retentionDays: number; nowMs: number },
): Record<string, number> {
  const removed: Record<string, number> = {};
  if (opts.retentionDays <= 0) return removed;
  const cutoff = opts.nowMs - opts.retentionDays * DAY_MS;
  for (const { table, column } of ACTIVITY_TABLES) {
    if (!tableExists(db, table)) continue;
    removed[table] = Number(
      dbRun(db, `DELETE FROM ${table} WHERE ${column} < ?`, [cutoff]).changes,
    );
  }
  return removed;
}

/**
 * Prune once now, then daily. A failed tick never escapes; the handle's `stop` clears the timer.
 */
export function startActivityRetention(
  db: Database,
  opts: { retentionDays?: number; nowMs?: () => number } = {},
): { stop(): void } {
  const retentionDays = opts.retentionDays ?? ACTIVITY_RETENTION_DAYS;
  const clock = opts.nowMs ?? Date.now;
  const tick = (): void => {
    try {
      pruneActivityHistory(db, { retentionDays, nowMs: clock() });
    } catch {
      /* best-effort maintenance: a busy or closed handle retries tomorrow */
    }
  };
  tick();
  const timer = setInterval(tick, ACTIVITY_PRUNE_INTERVAL_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
