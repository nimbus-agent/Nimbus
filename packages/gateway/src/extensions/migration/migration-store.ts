import type { Database } from "bun:sqlite";

import { dbRun } from "../../db/write.ts";
import { readIndexedUserVersion } from "../../index/migrations/runner.ts";

/**
 * The `connector_migration` table (V73): one row per bundled connector being moved to a signed,
 * registry-installed extension (Readwise unbundling spec § 7.2). `legacy_service_id` is UNIQUE, so
 * the table itself is the dedup — a legacy connector has at most one migration row, ever.
 *
 * The spec's `prepared` state is folded into `awaiting_approval`: a row is written only once the
 * package is fetched, verified and staged, so there is no observable gap between the two.
 * `approved` and `declined` are terminal — every write below refuses to move a row out of either.
 */
export const MIGRATION_SCHEMA_VERSION = 73;

export type MigrationState = "awaiting_approval" | "approved" | "declined" | "failed";

export interface MigrationRow {
  id: string;
  legacyServiceId: string;
  extensionId: string;
  version: string | null;
  treeDigest: string | null;
  stagePath: string | null;
  state: MigrationState;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

type RawRow = {
  id: string;
  legacy_service_id: string;
  extension_id: string;
  version: string | null;
  tree_digest: string | null;
  stage_path: string | null;
  state: string;
  error: string | null;
  created_at: number;
  updated_at: number;
};

const COLS =
  "id, legacy_service_id, extension_id, version, tree_digest, stage_path, state, error, created_at, updated_at";

const STATES: readonly MigrationState[] = ["awaiting_approval", "approved", "declined", "failed"];

function isState(s: string): s is MigrationState {
  return (STATES as readonly string[]).includes(s);
}

function hasTable(db: Database): boolean {
  return readIndexedUserVersion(db) >= MIGRATION_SCHEMA_VERSION;
}

function toRow(r: RawRow): MigrationRow {
  // The CHECK constraint makes any other value impossible; refuse rather than guess if it ever is.
  if (!isState(r.state)) throw new Error(`connector_migration ${r.id} has an unknown state`);
  return {
    id: r.id,
    legacyServiceId: r.legacy_service_id,
    extensionId: r.extension_id,
    version: r.version,
    treeDigest: r.tree_digest,
    stagePath: r.stage_path,
    state: r.state,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getMigration(db: Database, id: string): MigrationRow | undefined {
  if (!hasTable(db)) return undefined;
  const r = db
    .query(`SELECT ${COLS} FROM connector_migration WHERE id = ?`)
    .get(id) as RawRow | null;
  return r === null ? undefined : toRow(r);
}

export function getMigrationByLegacyService(
  db: Database,
  legacyServiceId: string,
): MigrationRow | undefined {
  if (!hasTable(db)) return undefined;
  const r = db
    .query(`SELECT ${COLS} FROM connector_migration WHERE legacy_service_id = ?`)
    .get(legacyServiceId) as RawRow | null;
  return r === null ? undefined : toRow(r);
}

export function listMigrations(db: Database): MigrationRow[] {
  if (!hasTable(db)) return [];
  return (
    db.query(`SELECT ${COLS} FROM connector_migration ORDER BY created_at, id`).all() as RawRow[]
  ).map(toRow);
}

/**
 * The migration awaiting approval for an extension id, if any. The migration-approval entry point
 * of `approve-run.ts` refuses without one, so a run grant can be written without its own prompt
 * only while the owner's `extension.migrate` decision for exactly this extension is in progress.
 */
export function pendingMigrationForExtension(
  db: Database,
  extensionId: string,
): MigrationRow | undefined {
  if (!hasTable(db)) return undefined;
  const r = db
    .query(
      `SELECT ${COLS} FROM connector_migration WHERE extension_id = ? AND state = 'awaiting_approval' ORDER BY created_at LIMIT 1`,
    )
    .get(extensionId) as RawRow | null;
  return r === null ? undefined : toRow(r);
}

export interface PreparedMigration {
  id: string;
  legacyServiceId: string;
  extensionId: string;
  version: string;
  treeDigest: string;
  stagePath: string;
}

export interface FailedMigration {
  id: string;
  legacyServiceId: string;
  extensionId: string;
  error: string;
}

/**
 * Inserts or replaces the row for a legacy service. On conflict the existing row keeps its id and
 * creation time, and a terminal (`approved`/`declined`) row is never touched. Returns whether a row
 * was written.
 */
function upsert(
  db: Database,
  v: {
    id: string;
    legacyServiceId: string;
    extensionId: string;
    version: string | null;
    treeDigest: string | null;
    stagePath: string | null;
    state: "awaiting_approval" | "failed";
    error: string | null;
  },
  now: number,
): boolean {
  const r = dbRun(
    db,
    `INSERT INTO connector_migration (${COLS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(legacy_service_id) DO UPDATE SET
       extension_id = excluded.extension_id,
       version      = excluded.version,
       tree_digest  = excluded.tree_digest,
       stage_path   = excluded.stage_path,
       state        = excluded.state,
       error        = excluded.error,
       updated_at   = excluded.updated_at
     WHERE connector_migration.state NOT IN ('approved', 'declined')`,
    [
      v.id,
      v.legacyServiceId,
      v.extensionId,
      v.version,
      v.treeDigest,
      v.stagePath,
      v.state,
      v.error,
      now,
      now,
    ],
  );
  return r.changes > 0;
}

/** A verified, staged package now awaits the owner's one decision. */
export function recordMigrationPrepared(db: Database, m: PreparedMigration, now: number): boolean {
  return upsert(db, { ...m, state: "awaiting_approval", error: null }, now);
}

/** Prepare (or a later step) failed; nothing is staged. Retried on the next evaluation. */
export function recordMigrationFailed(db: Database, m: FailedMigration, now: number): boolean {
  return upsert(
    db,
    { ...m, version: null, treeDigest: null, stagePath: null, state: "failed" },
    now,
  );
}

/**
 * Moves a row that is `awaiting_approval` to a final state, conditionally: a row in any other state
 * (or gone) changes nothing and `false` is returned. The stage path is cleared in every case — the
 * staged tree is deleted on approve, decline and failure alike.
 */
export function finishMigration(
  db: Database,
  id: string,
  to: "approved" | "declined" | "failed",
  error: string | null,
  now: number,
): boolean {
  const r = dbRun(
    db,
    `UPDATE connector_migration SET state = ?, error = ?, stage_path = NULL, updated_at = ?
     WHERE id = ? AND state = 'awaiting_approval'`,
    [to, error, now, id],
  );
  return r.changes > 0;
}
