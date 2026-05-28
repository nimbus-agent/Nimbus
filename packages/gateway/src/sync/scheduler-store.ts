import type { Database } from "bun:sqlite";

import { dbRun } from "../db/write.ts";

export type PersistedSchedulerStatus = "ok" | "backoff" | "error";

export type SchedulerStateRow = {
  service_id: string;
  cursor: string | null;
  interval_ms: number;
  last_sync_at: number | null;
  next_sync_at: number | null;
  status: PersistedSchedulerStatus;
  error_msg: string | null;
  consecutive_failures: number;
  paused: number;
};

export function loadSchedulerState(db: Database, serviceId: string): SchedulerStateRow | null {
  const row = db
    .query(
      `SELECT service_id, cursor, interval_ms, last_sync_at, next_sync_at, status, error_msg,
              consecutive_failures, paused
       FROM scheduler_state WHERE service_id = ?`,
    )
    .get(serviceId) as
    | {
        service_id: string;
        cursor: string | null;
        interval_ms: number;
        last_sync_at: number | null;
        next_sync_at: number | null;
        status: string;
        error_msg: string | null;
        consecutive_failures: number;
        paused: number;
      }
    | null
    | undefined;
  if (row === null || row === undefined) {
    return null;
  }
  return parseSchedulerRow(row);
}

export function upsertSchedulerRegistration(
  db: Database,
  serviceId: string,
  intervalMs: number,
  now: number,
  updateInterval: boolean,
): void {
  const existing = loadSchedulerState(db, serviceId);
  if (existing === null) {
    dbRun(
      db,
      `INSERT INTO scheduler_state (service_id, cursor, interval_ms, last_sync_at, next_sync_at, status, error_msg, consecutive_failures, paused)
       VALUES (?, NULL, ?, NULL, ?, 'ok', NULL, 0, 0)`,
      [serviceId, intervalMs, now],
    );
    return;
  }
  if (updateInterval) {
    setIntervalMs(db, serviceId, intervalMs);
  }
}

export function updateSchedulerState(
  db: Database,
  params: {
    serviceId: string;
    cursor: string | null;
    intervalMs: number;
    lastSyncAt: number | null;
    nextSyncAt: number | null;
    status: PersistedSchedulerStatus;
    errorMsg: string | null;
    consecutiveFailures: number;
    paused: boolean;
  },
): void {
  dbRun(
    db,
    `UPDATE scheduler_state SET
       cursor = ?,
       interval_ms = ?,
       last_sync_at = ?,
       next_sync_at = ?,
       status = ?,
       error_msg = ?,
       consecutive_failures = ?,
       paused = ?
     WHERE service_id = ?`,
    [
      params.cursor,
      params.intervalMs,
      params.lastSyncAt,
      params.nextSyncAt,
      params.status,
      params.errorMsg,
      params.consecutiveFailures,
      params.paused ? 1 : 0,
      params.serviceId,
    ],
  );
}

export function setNextSyncAt(db: Database, serviceId: string, nextSyncAt: number | null): void {
  dbRun(db, `UPDATE scheduler_state SET next_sync_at = ? WHERE service_id = ?`, [
    nextSyncAt,
    serviceId,
  ]);
}

export function setPaused(db: Database, serviceId: string, paused: boolean): void {
  dbRun(db, `UPDATE scheduler_state SET paused = ? WHERE service_id = ?`, [
    paused ? 1 : 0,
    serviceId,
  ]);
}

export function setIntervalMs(db: Database, serviceId: string, intervalMs: number): void {
  dbRun(db, `UPDATE scheduler_state SET interval_ms = ? WHERE service_id = ?`, [
    intervalMs,
    serviceId,
  ]);
}

export function countItemsForService(db: Database, serviceId: string): number {
  const row = db.query(`SELECT COUNT(*) as c FROM item WHERE service = ?`).get(serviceId) as
    | { c: number }
    | null
    | undefined;
  const c = row?.c;
  return typeof c === "number" && Number.isFinite(c) ? Math.floor(c) : 0;
}

export function countItemsForAnyService(db: Database, services: readonly string[]): number {
  if (services.length === 0) {
    return 0;
  }
  const placeholders = services.map(() => "?").join(",");
  const row = db
    .query(`SELECT COUNT(*) as c FROM item WHERE service IN (${placeholders})`)
    .get(...services) as { c: number } | null | undefined;
  const c = row?.c;
  return typeof c === "number" && Number.isFinite(c) ? Math.floor(c) : 0;
}

function parseSchedulerRow(row: {
  service_id: string;
  cursor: string | null;
  interval_ms: number;
  last_sync_at: number | null;
  next_sync_at: number | null;
  status: string;
  error_msg: string | null;
  consecutive_failures: number;
  paused: number;
}): SchedulerStateRow | null {
  const st = row.status;
  if (st !== "ok" && st !== "backoff" && st !== "error") {
    return null;
  }
  return {
    service_id: row.service_id,
    cursor: row.cursor,
    interval_ms: row.interval_ms,
    last_sync_at: row.last_sync_at,
    next_sync_at: row.next_sync_at,
    status: st,
    error_msg: row.error_msg,
    consecutive_failures: row.consecutive_failures,
    paused: row.paused,
  };
}

export function listAllSchedulerStates(db: Database): SchedulerStateRow[] {
  const rows = db
    .query(
      `SELECT service_id, cursor, interval_ms, last_sync_at, next_sync_at, status, error_msg,
              consecutive_failures, paused
       FROM scheduler_state ORDER BY service_id ASC`,
    )
    .all() as Array<{
    service_id: string;
    cursor: string | null;
    interval_ms: number;
    last_sync_at: number | null;
    next_sync_at: number | null;
    status: string;
    error_msg: string | null;
    consecutive_failures: number;
    paused: number;
  }>;
  const out: SchedulerStateRow[] = [];
  for (const r of rows) {
    const parsed = parseSchedulerRow(r);
    if (parsed !== null) {
      out.push(parsed);
    }
  }
  return out;
}

export function clearSchedulerCursor(db: Database, serviceId: string): void {
  dbRun(db, `UPDATE scheduler_state SET cursor = NULL WHERE service_id = ?`, [serviceId]);
}

export function deleteSchedulerStateRow(db: Database, serviceId: string): void {
  dbRun(db, `DELETE FROM scheduler_state WHERE service_id = ?`, [serviceId]);
}

export function insertSyncTelemetry(
  db: Database,
  row: {
    service: string;
    startedAt: number;
    durationMs: number;
    itemsUpserted: number;
    itemsDeleted: number;
    bytesTransferred: number | null;
    hadMore: boolean;
    errorMsg: string | null;
  },
): void {
  dbRun(
    db,
    `INSERT INTO sync_telemetry (
       service, started_at, duration_ms, items_upserted, items_deleted, bytes_transferred, had_more, error_msg
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.service,
      row.startedAt,
      row.durationMs,
      row.itemsUpserted,
      row.itemsDeleted,
      row.bytesTransferred,
      row.hadMore ? 1 : 0,
      row.errorMsg,
    ],
  );
}

export type SyncTelemetryRow = {
  startedAt: number;
  durationMs: number;
  itemsUpserted: number;
  itemsDeleted: number;
  bytesTransferred: number | null;
  hadMore: boolean;
  errorMsg: string | null;
};

export function listRecentSyncTelemetry(
  db: Database,
  service: string,
  limit: number,
): SyncTelemetryRow[] {
  const cap = Math.min(100, Math.max(1, Math.floor(limit)));
  const rows = db
    .query(
      `SELECT started_at, duration_ms, items_upserted, items_deleted, bytes_transferred, had_more, error_msg
       FROM sync_telemetry WHERE service = ? ORDER BY started_at DESC LIMIT ?`,
    )
    .all(service, cap) as Array<{
    started_at: number;
    duration_ms: number;
    items_upserted: number;
    items_deleted: number;
    bytes_transferred: number | null;
    had_more: number;
    error_msg: string | null;
  }>;
  const out: SyncTelemetryRow[] = [];
  for (const r of rows) {
    out.push({
      startedAt: r.started_at,
      durationMs: r.duration_ms,
      itemsUpserted: r.items_upserted,
      itemsDeleted: r.items_deleted,
      bytesTransferred: r.bytes_transferred,
      hadMore: r.had_more === 1,
      errorMsg: r.error_msg,
    });
  }
  return out;
}
