import type { Database } from "bun:sqlite";

import { dbRun } from "../db/write.ts";
import { readIndexedUserVersion } from "../index/migrations/runner.ts";
import { EXTENSION_SERVICE_ID_PATTERN } from "./extension-service-id.ts";

/**
 * The ONLY code that names `extension_run_grant` (static rule D33(b)). A grant records exactly what
 * the owner approved through the `extension.run` HITL gate — nothing else may create one: static
 * rule D33(c) confines `upsertRunGrant` to this file and `approve-run.ts`, and `deleteRunGrant` to
 * those two and `automation/extension-store.ts`.
 */
export const RUN_GRANT_SCHEMA_VERSION = 70;

export type ExtensionRunGrantRow = {
  extension_id: string;
  service_id: string;
  version: string;
  tree_digest: string;
  permissions_json: string;
  model_access: number;
  approved_at: number;
};

const COLS =
  "extension_id, service_id, version, tree_digest, permissions_json, model_access, approved_at";

function hasTable(db: Database): boolean {
  return readIndexedUserVersion(db) >= RUN_GRANT_SCHEMA_VERSION;
}

export function getRunGrant(db: Database, extensionId: string): ExtensionRunGrantRow | null {
  if (!hasTable(db)) return null;
  const row = db
    .query(`SELECT ${COLS} FROM extension_run_grant WHERE extension_id = ?`)
    .get(extensionId) as ExtensionRunGrantRow | null;
  return row ?? null;
}

export function listRunGrants(db: Database): ExtensionRunGrantRow[] {
  if (!hasTable(db)) return [];
  return db
    .query(`SELECT ${COLS} FROM extension_run_grant ORDER BY extension_id`)
    .all() as ExtensionRunGrantRow[];
}

/**
 * The model's extension source (I42): grants approved with `--model` whose extension is enabled
 * and whose version and tree digest still match the row (a stale grant would only fail to spawn
 * on every turn). Not verification — the spawn path re-verifies; this only narrows.
 */
export function listModelAccessibleExtensionGrants(
  db: Database,
): { serviceId: string; extensionId: string }[] {
  if (!hasTable(db)) return [];
  const rows = db
    .query(
      `SELECT g.service_id AS service_id, g.extension_id AS extension_id
         FROM extension_run_grant g
         JOIN extension e ON e.id = g.extension_id
        WHERE g.model_access = 1
          AND e.enabled = 1
          AND e.version = g.version
          AND e.tree_digest = g.tree_digest
        ORDER BY g.service_id`,
    )
    .all() as { service_id: string; extension_id: string }[];
  return rows
    .filter((r) => EXTENSION_SERVICE_ID_PATTERN.test(r.service_id))
    .map((r) => ({ serviceId: r.service_id, extensionId: r.extension_id }));
}

/** Creates or replaces the extension's grant. Throws below V70 rather than dropping a grant. */
export function upsertRunGrant(db: Database, row: ExtensionRunGrantRow): void {
  if (!hasTable(db)) {
    throw new Error("Extension run grants require schema v70+");
  }
  dbRun(
    db,
    `INSERT INTO extension_run_grant (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(extension_id) DO UPDATE SET
       service_id = excluded.service_id,
       version = excluded.version,
       tree_digest = excluded.tree_digest,
       permissions_json = excluded.permissions_json,
       model_access = excluded.model_access,
       approved_at = excluded.approved_at`,
    [
      row.extension_id,
      row.service_id,
      row.version,
      row.tree_digest,
      row.permissions_json,
      row.model_access,
      row.approved_at,
    ],
  );
}

export function deleteRunGrant(db: Database, extensionId: string): boolean {
  if (!hasTable(db)) return false;
  return (
    dbRun(db, `DELETE FROM extension_run_grant WHERE extension_id = ?`, [extensionId]).changes > 0
  );
}
