import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import { dbRun } from "../db/write.ts";
import { readIndexedUserVersion } from "../index/migrations/runner.ts";

export type WatcherRow = {
  id: string;
  name: string;
  enabled: number;
  condition_type: string;
  condition_json: string;
  action_type: string;
  action_json: string;
  created_at: number;
  last_checked_at: number | null;
  last_fired_at: number | null;
  graph_predicate_json: string | null;
};

export function listWatchers(db: Database): WatcherRow[] {
  if (readIndexedUserVersion(db) < 8) {
    return [];
  }
  return db
    .query(
      `SELECT id, name, enabled, condition_type, condition_json, action_type, action_json,
              created_at, last_checked_at, last_fired_at, graph_predicate_json
       FROM watcher ORDER BY name`,
    )
    .all() as WatcherRow[];
}

export function listEnabledWatchers(db: Database): WatcherRow[] {
  return listWatchers(db).filter((w) => w.enabled === 1);
}

export function insertWatcher(
  db: Database,
  row: Omit<WatcherRow, "id" | "last_checked_at" | "last_fired_at" | "graph_predicate_json"> & {
    id?: string;
    graph_predicate_json?: string | null;
  },
): string {
  if (readIndexedUserVersion(db) < 8) {
    throw new Error("Watcher schema requires v8+");
  }
  const id = row.id ?? randomUUID();
  const now = row.created_at;
  const gpj = row.graph_predicate_json ?? null;
  dbRun(
    db,
    `INSERT INTO watcher (id, name, enabled, condition_type, condition_json,
                          action_type, action_json, created_at, graph_predicate_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      row.name,
      row.enabled,
      row.condition_type,
      row.condition_json,
      row.action_type,
      row.action_json,
      now,
      gpj,
    ],
  );
  return id;
}

/**
 * Insert only when `id` is absent, and never touch an existing row's `enabled`
 * (or any other column). `insertWatcher` is a bare `INSERT`, so calling it
 * twice with a content-derived id raises a primary-key constraint error —
 * that collision is exactly the re-run case this helper exists to make safe.
 * A naive upsert (`ON CONFLICT DO UPDATE SET enabled = excluded.enabled`)
 * would silently re-pause a watcher the user had deliberately armed, which is
 * the one behavior this table must never produce.
 */
export function insertWatcherIfAbsent(
  db: Database,
  row: Omit<WatcherRow, "last_checked_at" | "last_fired_at" | "graph_predicate_json"> & {
    graph_predicate_json?: string | null;
  },
): boolean {
  if (readIndexedUserVersion(db) < 8) {
    throw new Error("Watcher schema requires v8+");
  }
  const existing = db.query(`SELECT 1 FROM watcher WHERE id = ?`).get(row.id);
  if (existing !== null) {
    return false;
  }
  const gpj = row.graph_predicate_json ?? null;
  dbRun(
    db,
    `INSERT INTO watcher (id, name, enabled, condition_type, condition_json,
                          action_type, action_json, created_at, graph_predicate_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.name,
      row.enabled,
      row.condition_type,
      row.condition_json,
      row.action_type,
      row.action_json,
      row.created_at,
      gpj,
    ],
  );
  return true;
}

export function deleteWatcher(db: Database, id: string): void {
  if (readIndexedUserVersion(db) < 8) {
    return;
  }
  dbRun(db, `DELETE FROM watcher WHERE id = ?`, [id]);
}

export function setWatcherEnabled(db: Database, id: string, enabled: boolean): boolean {
  if (readIndexedUserVersion(db) < 8) {
    return false;
  }
  const r = dbRun(db, `UPDATE watcher SET enabled = ? WHERE id = ?`, [enabled ? 1 : 0, id]);
  return r.changes > 0;
}

export function updateWatcherLastChecked(db: Database, id: string, ts: number): void {
  dbRun(db, `UPDATE watcher SET last_checked_at = ? WHERE id = ?`, [ts, id]);
}

export function updateWatcherLastFired(db: Database, id: string, ts: number): void {
  dbRun(db, `UPDATE watcher SET last_fired_at = ? WHERE id = ?`, [ts, id]);
}

export function insertWatcherEvent(
  db: Database,
  watcherId: string,
  firedAt: number,
  conditionSnapshot: string,
  actionResult: string | null,
): void {
  dbRun(
    db,
    `INSERT INTO watcher_event (watcher_id, fired_at, condition_snapshot, action_result)
     VALUES (?, ?, ?, ?)`,
    [watcherId, firedAt, conditionSnapshot, actionResult],
  );
}

export function setWatcherGraphPredicate(
  db: Database,
  id: string,
  graphPredicateJson: string | null,
): boolean {
  if (readIndexedUserVersion(db) < 22) {
    return false;
  }
  const r = dbRun(db, `UPDATE watcher SET graph_predicate_json = ? WHERE id = ?`, [
    graphPredicateJson,
    id,
  ]);
  return r.changes > 0;
}
