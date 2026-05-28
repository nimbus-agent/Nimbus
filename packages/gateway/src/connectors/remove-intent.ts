import type { Database } from "bun:sqlite";

import { dbRun } from "../db/write.ts";

export const CONNECTOR_REMOVE_INTENT_V15_SQL = `
CREATE TABLE IF NOT EXISTS connector_remove_intent (
  service_id  TEXT PRIMARY KEY,
  started_at  INTEGER NOT NULL
);
`;

export function writeRemoveIntent(db: Database, serviceId: string): void {
  dbRun(
    db,
    `INSERT OR REPLACE INTO connector_remove_intent (service_id, started_at) VALUES (?, ?)`,
    [serviceId, Date.now()],
  );
}

export function clearRemoveIntent(db: Database, serviceId: string): void {
  dbRun(db, `DELETE FROM connector_remove_intent WHERE service_id = ?`, [serviceId]);
}

export function getPendingRemoveIntents(db: Database): string[] {
  const rows = db
    .query<{ service_id: string }, []>(
      `SELECT service_id FROM connector_remove_intent ORDER BY started_at ASC`,
    )
    .all();
  return rows.map((r) => r.service_id);
}
