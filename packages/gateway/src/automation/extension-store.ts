import type { Database } from "bun:sqlite";

import { dbRun } from "../db/write.ts";
import { deleteRunGrant } from "../extensions/run-grant-store.ts";
import { readIndexedUserVersion } from "../index/migrations/runner.ts";

/** V79: what an installed package is — code to run, or a starter pack (dependencies, no code). */
export type ExtensionKind = "extension" | "starter-pack";

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
  /** V71: the registry, root-key fingerprint and channel an extension was installed from; `null` for a local install. */
  source_registry?: string | null;
  source_root_fingerprint?: string | null;
  source_channel?: "stable" | "beta" | null;
  /**
   * V76: `publisherKeyFingerprint` of the key that verified the installed copy; `null` for an
   * unsigned extension, or until the boot backfill fills it for a row installed before V76.
   */
  publisher_key_fingerprint?: string | null;
  /**
   * V79: `"starter-pack"` for a package of dependencies with no code, else `"extension"`. Every row
   * {@link listExtensions} returns carries it (`"extension"` below V79); optional only so a row
   * built by hand for a code extension may leave it out.
   */
  kind?: ExtensionKind;
};

/** V66 added `tree_digest`; below it the column does not exist and every row reads `null`. */
const TREE_DIGEST_SCHEMA_VERSION = 66;

/** V71 added the three `source_*` columns; below it every row reads `null` for each. */
const SOURCE_SCHEMA_VERSION = 71;

/** V76 added `publisher_key_fingerprint`; below it every row reads `null`. */
const PUBLISHER_KEY_FINGERPRINT_SCHEMA_VERSION = 76;

/** V79 added `kind`; below it every row is an extension. */
const KIND_SCHEMA_VERSION = 79;

function hasKindColumn(db: Database): boolean {
  return readIndexedUserVersion(db) >= KIND_SCHEMA_VERSION;
}

function hasTreeDigestColumn(db: Database): boolean {
  return readIndexedUserVersion(db) >= TREE_DIGEST_SCHEMA_VERSION;
}

export function listExtensions(db: Database): ExtensionRow[] {
  if (readIndexedUserVersion(db) < 10) {
    return [];
  }
  const digest = hasTreeDigestColumn(db) ? "tree_digest" : "NULL AS tree_digest";
  const source =
    readIndexedUserVersion(db) >= SOURCE_SCHEMA_VERSION
      ? "source_registry, source_root_fingerprint, source_channel"
      : "NULL AS source_registry, NULL AS source_root_fingerprint, NULL AS source_channel";
  const keyFp =
    readIndexedUserVersion(db) >= PUBLISHER_KEY_FINGERPRINT_SCHEMA_VERSION
      ? "publisher_key_fingerprint"
      : "NULL AS publisher_key_fingerprint";
  const kind = hasKindColumn(db) ? "kind" : "'extension' AS kind";
  return db
    .query(
      `SELECT id, version, install_path, manifest_hash, entry_hash, enabled, installed_at, last_verified_at, ${digest}, ${source}, ${keyFp}, ${kind}
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

/**
 * Records which publisher key verified the installed copy (V76). Throws below V76 rather than
 * dropping a fingerprint a caller believes it stored.
 */
export function setExtensionPublisherKeyFingerprint(
  db: Database,
  id: string,
  fingerprint: string | null,
): boolean {
  if (readIndexedUserVersion(db) < PUBLISHER_KEY_FINGERPRINT_SCHEMA_VERSION) {
    throw new Error("Extension publisher key fingerprint requires schema v76+");
  }
  const r = dbRun(db, "UPDATE extension SET publisher_key_fingerprint = ? WHERE id = ?", [
    fingerprint,
    id,
  ]);
  return r.changes > 0;
}

const INSTALLED_AS_DEPENDENCY_SCHEMA_VERSION = 78;

/** V78: marks an extension installed only because another extension depends on it. Throws below V78. */
export function setInstalledAsDependency(db: Database, id: string, asDependency: boolean): void {
  if (readIndexedUserVersion(db) < INSTALLED_AS_DEPENDENCY_SCHEMA_VERSION) {
    throw new Error("The dependency marker requires schema v78+");
  }
  dbRun(db, "UPDATE extension SET installed_as_dependency = ? WHERE id = ?", [
    asDependency ? 1 : 0,
    id,
  ]);
}

/** V78: whether the extension was installed as a dependency; false below V78. */
export function isInstalledAsDependency(db: Database, id: string): boolean {
  if (readIndexedUserVersion(db) < INSTALLED_AS_DEPENDENCY_SCHEMA_VERSION) {
    return false;
  }
  const row = db
    .query("SELECT installed_as_dependency AS d FROM extension WHERE id = ?")
    .get(id) as { d: number } | null;
  return row?.d === 1;
}

/** V79: the installed package's kind; `undefined` when no such row, `"extension"` below V79. */
export function getExtensionKind(db: Database, id: string): ExtensionKind | undefined {
  if (readIndexedUserVersion(db) < 10) {
    return undefined;
  }
  const kind = hasKindColumn(db) ? "kind" : "'extension' AS kind";
  const row = db.query(`SELECT ${kind} FROM extension WHERE id = ?`).get(id) as {
    kind: ExtensionKind;
  } | null;
  return row?.kind;
}

/**
 * V79: records the kind of the manifest now installed for `id` (an update can replace an extension
 * with a starter pack, or the reverse). A no-op below V79, where every row reads `"extension"`.
 *
 * Recording `"starter-pack"` also deletes the row's run grant: a pack has no code, so it never
 * holds one (I43), and a grant the owner gave the code it replaced must not survive. Callers run
 * this inside the transaction that rewrites the row, so the two land together.
 */
export function setExtensionKind(db: Database, id: string, kind: ExtensionKind): void {
  if (!hasKindColumn(db)) return;
  dbRun(db, "UPDATE extension SET kind = ? WHERE id = ?", [kind, id]);
  if (kind === "starter-pack") deleteRunGrant(db, id);
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
  if (hasKindColumn(db)) {
    dbRun(
      db,
      `INSERT INTO extension (id, version, install_path, manifest_hash, entry_hash, enabled, installed_at, last_verified_at, tree_digest, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        row.kind ?? "extension",
      ],
    );
    return;
  }
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
