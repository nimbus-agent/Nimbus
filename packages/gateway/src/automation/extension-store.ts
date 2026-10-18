import type { Database } from "bun:sqlite";

import { dbRun } from "../db/write.ts";
import { deleteRunGrant } from "../extensions/run-grant-store.ts";
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
  /**
   * SHA-256 over every file in `install_path` (`extensions/tree-digest.ts`), or `null` when the
   * row predates V66 or its bytes changed through a path that did not recompute it. A `null`
   * digest vouches for nothing.
   */
  tree_digest: string | null;
};

/** V66 added `tree_digest`; below it the column does not exist and every row reads `null`. */
const TREE_DIGEST_SCHEMA_VERSION = 66;

function hasTreeDigestColumn(db: Database): boolean {
  return readIndexedUserVersion(db) >= TREE_DIGEST_SCHEMA_VERSION;
}

export function listExtensions(db: Database): ExtensionRow[] {
  if (readIndexedUserVersion(db) < 10) {
    return [];
  }
  const digest = hasTreeDigestColumn(db) ? "tree_digest" : "NULL AS tree_digest";
  return db
    .query(
      `SELECT id, version, install_path, manifest_hash, entry_hash, enabled, installed_at, last_verified_at, ${digest}
       FROM extension ORDER BY id`,
    )
    .all() as ExtensionRow[];
}

/**
 * Records the digest of the bytes now at the row's `install_path`. Throws below V66 rather than
 * silently dropping a digest a caller believes it stored.
 */
export function setExtensionTreeDigest(db: Database, id: string, treeDigest: string): boolean {
  if (!hasTreeDigestColumn(db)) {
    throw new Error("Extension tree digest requires schema v66+");
  }
  const r = dbRun(db, `UPDATE extension SET tree_digest = ? WHERE id = ?`, [treeDigest, id]);
  return r.changes > 0;
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
  treeDigest: string | null = null,
): boolean {
  if (readIndexedUserVersion(db) < 10) {
    return false;
  }
  // The bytes under install_path just changed, so whatever digest the row held describes code that
  // is no longer there. It is cleared here, in the one statement every version change goes through,
  // so a path that forgets to recompute leaves a digest that vouches for nothing rather than one
  // that vouches for the wrong bytes. A caller that has hashed the new tree passes it as
  // `treeDigest` (written in this same statement) or follows up with `setExtensionTreeDigest`;
  // omitted, the digest is NULL.
  const hasDigest = hasTreeDigestColumn(db);
  const digestSet = hasDigest ? ", tree_digest = ?" : "";
  const r = dbRun(
    db,
    `UPDATE extension
        SET version = ?, manifest_hash = ?, entry_hash = ?, last_verified_at = ?${digestSet}
      WHERE id = ?`,
    hasDigest
      ? [version, manifestHash, entryHash, lastVerifiedAt, treeDigest, id]
      : [version, manifestHash, entryHash, lastVerifiedAt, id],
  );
  return r.changes > 0;
}

export function insertExtensionRow(
  db: Database,
  row: Omit<ExtensionRow, "enabled" | "tree_digest"> & {
    enabled?: number;
    tree_digest?: string | null;
  },
): void {
  if (readIndexedUserVersion(db) < 10) {
    throw new Error("Extension registry requires schema v10+");
  }
  const enabled = row.enabled ?? 1;
  if (hasTreeDigestColumn(db)) {
    dbRun(
      db,
      `INSERT INTO extension (id, version, install_path, manifest_hash, entry_hash, enabled, installed_at, last_verified_at, tree_digest)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.version,
        row.install_path,
        row.manifest_hash,
        row.entry_hash,
        enabled,
        row.installed_at,
        row.last_verified_at,
        row.tree_digest ?? null,
      ],
    );
    return;
  }
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
  // Deleted explicitly rather than left to the FK cascade: the cascade fires only on a connection
  // with foreign_keys = ON (LocalIndex sets it; a caller holding a different connection may not).
  deleteRunGrant(db, id);
  dbRun(db, `DELETE FROM extension WHERE id = ?`, [id]);
  return path;
}
