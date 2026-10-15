import type { Database } from "bun:sqlite";

import { dbRun } from "../db/write.ts";
import type { ResolvedRunGrantPermissions } from "../extensions/run-grant-resolve.ts";
import { readIndexedUserVersion } from "../index/migrations/runner.ts";

/** V69 added `extension_run_grant`; below it no extension has a grant and writes throw. */
const RUN_GRANT_SCHEMA_VERSION = 69;

/**
 * The owner's standing approval to run one installed extension (extension-runtime design § 4.4).
 * It is bound to the exact bytes approved: a grant whose `version` or `treeDigest` differs from the
 * extension row's current values approves nothing, and PR 3's runtime will treat it that way.
 */
export type ExtensionRunGrant = {
  readonly extensionId: string;
  readonly serviceId: string;
  readonly version: string;
  readonly treeDigest: string;
  readonly permissions: ResolvedRunGrantPermissions;
  readonly modelAccess: boolean;
  readonly approvedAt: number;
};

type GrantRow = {
  extension_id: string;
  service_id: string;
  version: string;
  tree_digest: string;
  permissions_json: string;
  model_access: number;
  approved_at: number;
};

function hasGrantTable(db: Database): boolean {
  return readIndexedUserVersion(db) >= RUN_GRANT_SCHEMA_VERSION;
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Parses the stored JSON; anything malformed reads as empty, which grants less, never more. */
function parsePermissions(json: string): ResolvedRunGrantPermissions {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    raw = undefined;
  }
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const fsRaw = o["filesystem"];
  const fs = typeof fsRaw === "object" && fsRaw !== null ? (fsRaw as Record<string, unknown>) : {};
  return {
    network: stringArray(o["network"]),
    filesystem: { read: stringArray(fs["read"]), write: stringArray(fs["write"]) },
  };
}

function fromRow(r: GrantRow): ExtensionRunGrant {
  return {
    extensionId: r.extension_id,
    serviceId: r.service_id,
    version: r.version,
    treeDigest: r.tree_digest,
    permissions: parsePermissions(r.permissions_json),
    modelAccess: r.model_access === 1,
    approvedAt: r.approved_at,
  };
}

const SELECT = `SELECT extension_id, service_id, version, tree_digest, permissions_json, model_access, approved_at
  FROM extension_run_grant`;

export function getExtensionRunGrant(db: Database, extensionId: string): ExtensionRunGrant | null {
  if (!hasGrantTable(db)) return null;
  const r = db.query(`${SELECT} WHERE extension_id = ?`).get(extensionId) as GrantRow | null;
  return r === null ? null : fromRow(r);
}

export function listExtensionRunGrants(db: Database): ExtensionRunGrant[] {
  if (!hasGrantTable(db)) return [];
  return (db.query(`${SELECT} ORDER BY extension_id`).all() as GrantRow[]).map(fromRow);
}

/**
 * Writes (or replaces) an extension's grant. The caller is the `extension.approveRun` handler, after
 * the owner approved exactly these values. Throws below V69 rather than dropping an approval.
 */
export function upsertExtensionRunGrant(db: Database, grant: ExtensionRunGrant): void {
  if (!hasGrantTable(db)) {
    throw new Error("Extension run grants require schema v69+");
  }
  dbRun(
    db,
    `INSERT INTO extension_run_grant
       (extension_id, service_id, version, tree_digest, permissions_json, model_access, approved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(extension_id) DO UPDATE SET
       service_id = excluded.service_id,
       version = excluded.version,
       tree_digest = excluded.tree_digest,
       permissions_json = excluded.permissions_json,
       model_access = excluded.model_access,
       approved_at = excluded.approved_at`,
    [
      grant.extensionId,
      grant.serviceId,
      grant.version,
      grant.treeDigest,
      JSON.stringify(grant.permissions),
      grant.modelAccess ? 1 : 0,
      grant.approvedAt,
    ],
  );
}

/** Deletes an extension's grant; `true` when one existed. A no-op below V69. */
export function deleteExtensionRunGrant(db: Database, extensionId: string): boolean {
  if (!hasGrantTable(db)) return false;
  return (
    dbRun(db, `DELETE FROM extension_run_grant WHERE extension_id = ?`, [extensionId]).changes > 0
  );
}
