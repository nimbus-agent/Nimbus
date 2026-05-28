import type { Database } from "bun:sqlite";

import { dbRun } from "../db/write.ts";
import { readIndexedUserVersion } from "../index/migrations/runner.ts";

export type ExtensionRow = {
  id: string;
  version: string;
  install_path: string;
  manifest_hash: string;
  entry_hash: string;
  enabled: number;
  installed_at: number;
  last_verified_at: number;
};

export function listExtensions(db: Database): ExtensionRow[] {
  if (readIndexedUserVersion(db) < 10) {
    return [];
  }
  return db
    .query(
      `SELECT id, version, install_path, manifest_hash, entry_hash, enabled, installed_at, last_verified_at
       FROM extension ORDER BY id`,
    )
    .all() as ExtensionRow[];
}

export function touchExtensionVerifiedAt(db: Database, id: string, ts: number): void {
  if (readIndexedUserVersion(db) < 10) {
    return;
  }
  dbRun(db, `UPDATE extension SET last_verified_at = ? WHERE id = ?`, [ts, id]);
}

export function updateExtensionRowVersion(
  db: Database,
  id: string,
  version: string,
  manifestHash: string,
  entryHash: string,
  lastVerifiedAt: number,
): boolean {
  if (readIndexedUserVersion(db) < 10) {
    return false;
  }
  const r = dbRun(
    db,
    `UPDATE extension
        SET version = ?, manifest_hash = ?, entry_hash = ?, last_verified_at = ?
      WHERE id = ?`,
    [version, manifestHash, entryHash, lastVerifiedAt, id],
  );
  return r.changes > 0;
}

export function insertExtensionRow(
  db: Database,
  row: Omit<ExtensionRow, "enabled"> & { enabled?: number },
): void {
  if (readIndexedUserVersion(db) < 10) {
    throw new Error("Extension registry requires schema v10+");
  }
  const enabled = row.enabled ?? 1;
  dbRun(
    db,
    `INSERT INTO extension (id, version, install_path, manifest_hash, entry_hash, enabled, installed_at, last_verified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.version,
      row.install_path,
      row.manifest_hash,
      row.entry_hash,
      enabled,
      row.installed_at,
      row.last_verified_at,
    ],
  );
}

export function setExtensionEnabled(db: Database, id: string, enabled: boolean): boolean {
  if (readIndexedUserVersion(db) < 10) {
    return false;
  }
  const r = dbRun(db, `UPDATE extension SET enabled = ? WHERE id = ?`, [enabled ? 1 : 0, id]);
  return r.changes > 0;
}

export function selectExtensionInstallPath(db: Database, id: string): string | null {
  if (readIndexedUserVersion(db) < 10) {
    return null;
  }
  const row = db.query("SELECT install_path FROM extension WHERE id = ?").get(id) as {
    install_path: string;
  } | null;
  return row?.install_path ?? null;
}

export function deleteExtensionById(db: Database, id: string): string | null {
  if (readIndexedUserVersion(db) < 10) {
    return null;
  }
  const path = selectExtensionInstallPath(db, id);
  if (path === null) {
    return null;
  }
  dbRun(db, `DELETE FROM extension WHERE id = ?`, [id]);
  return path;
}
