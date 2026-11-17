// packages/gateway/src/automation/workflow-import-store.ts
// The provenance and replay floor of signed workflow imports (schema V101, I59, static D50(a)): the ONLY
// module that names the `workflow_import` table. Its writer, `recordImport`, is called only by
// `automation/workflow-import.ts`.
//
// Every function first checks the schema version (the V89 pattern in `workflow-store.ts`): below V101
// the reads return nothing and `recordImport` throws, so `workflow.list` works on an older database.
// Every write goes through `dbRun` (I14); every read binds its parameters (I9).
import type { Database } from "bun:sqlite";

import { dbRun } from "../db/write.ts";
import { readIndexedUserVersion } from "../index/migrations/runner.ts";

/** The migration that created `workflow_import`. */
export const IMPORT_SCHEMA_VERSION = 101;

export type ImportFloor = {
  readonly signerFingerprint: string;
  readonly bundleName: string;
  readonly issuedAt: number;
  readonly bundleSha256: string;
  readonly stepsSha256: string;
  readonly workflowId: string;
  readonly importedAt: number;
  readonly importCount: number;
};

export type ImportSource = {
  readonly signerFingerprint: string;
  readonly workflowId: string;
  readonly issuedAt: number;
  readonly stepsSha256: string;
  readonly importedAt: number;
};

export type RecordImportInput = {
  readonly signerFingerprint: string;
  readonly bundleName: string;
  readonly issuedAt: number;
  readonly bundleSha256: string;
  readonly stepsSha256: string;
  readonly signerPubkey: string;
  readonly authorLabel: string | null;
  readonly workflowId: string;
  readonly importedAt: number;
  readonly approvalAuditId: number;
};

type Row = {
  signer_fingerprint: string;
  bundle_name: string;
  issued_at: number;
  bundle_sha256: string;
  steps_sha256: string;
  workflow_id: string;
  imported_at: number;
  import_count: number;
};

const COLUMNS =
  "signer_fingerprint, bundle_name, issued_at, bundle_sha256, steps_sha256, workflow_id, imported_at, import_count";

function available(db: Database): boolean {
  return readIndexedUserVersion(db) >= IMPORT_SCHEMA_VERSION;
}

function floorOf(r: Row): ImportFloor {
  return {
    signerFingerprint: r.signer_fingerprint,
    bundleName: r.bundle_name,
    issuedAt: r.issued_at,
    bundleSha256: r.bundle_sha256,
    stepsSha256: r.steps_sha256,
    workflowId: r.workflow_id,
    importedAt: r.imported_at,
    importCount: r.import_count,
  };
}

function sourceOf(r: Row): ImportSource {
  return {
    signerFingerprint: r.signer_fingerprint,
    workflowId: r.workflow_id,
    issuedAt: r.issued_at,
    stepsSha256: r.steps_sha256,
    importedAt: r.imported_at,
  };
}

/** The replay floor for (signer, bundle name): the highest `issuedAt` ever imported, or `null`. */
export function floorFor(db: Database, signer: string, bundleName: string): ImportFloor | null {
  if (!available(db)) return null;
  const row = db
    .query(
      `SELECT ${COLUMNS} FROM workflow_import WHERE signer_fingerprint = ? AND bundle_name = ?`,
    )
    .get(signer, bundleName) as Row | null | undefined;
  return row === null || row === undefined ? null : floorOf(row);
}

/**
 * Where a workflow's content last came from: the row naming it with the highest `import_seq` (the
 * transaction order of imports; never `imported_at`, which a clock correction can reverse, nor rowid,
 * which an upsert keeps). A signer change leaves several rows with one `workflow_id`, so the order decides.
 * A display read: nothing in the rule or run path calls it (static D50(d)).
 */
export function readImportSource(db: Database, workflowId: string): ImportSource | null {
  if (!available(db)) return null;
  const row = db
    .query(
      `SELECT ${COLUMNS} FROM workflow_import WHERE workflow_id = ?
       ORDER BY import_seq DESC LIMIT 1`,
    )
    .get(workflowId) as Row | null | undefined;
  return row === null || row === undefined ? null : sourceOf(row);
}

/** One SELECT for `workflow list`: the newest source per workflow id (the first row per id wins). */
export function listSources(db: Database): Map<string, ImportSource> {
  const out = new Map<string, ImportSource>();
  if (!available(db)) return out;
  const rows = db
    .query(`SELECT ${COLUMNS} FROM workflow_import ORDER BY import_seq DESC`)
    .all() as Row[];
  for (const r of rows) {
    if (!out.has(r.workflow_id)) out.set(r.workflow_id, sourceOf(r));
  }
  return out;
}

/** Every signer that ever imported a bundle with this name (uses `workflow_import_name`). */
export function signersForName(db: Database, bundleName: string): ImportFloor[] {
  if (!available(db)) return [];
  const rows = db
    .query(
      `SELECT ${COLUMNS} FROM workflow_import WHERE bundle_name = ?
       ORDER BY import_seq DESC`,
    )
    .all(bundleName) as Row[];
  return rows.map(floorOf);
}

/** How often this signer's bundles were imported here, and when last; `null` for a first import. */
export function signerHistory(
  db: Database,
  signer: string,
): { readonly count: number; readonly lastAt: number } | null {
  if (!available(db)) return null;
  const row = db
    .query(
      `SELECT COALESCE(SUM(import_count), 0) AS n, MAX(imported_at) AS last
       FROM workflow_import WHERE signer_fingerprint = ?`,
    )
    .get(signer) as { n: number; last: number | null } | null | undefined;
  if (row === null || row === undefined || row.n === 0 || row.last === null) return null;
  return { count: row.n, lastAt: row.last };
}

/**
 * Records one approved import: raises the floor (`issued_at` only ever goes up) and bumps the count.
 * Returns `false` when the row exists with a HIGHER floor (an older bundle can never replace it), so
 * the caller treats it as stale. Throws below V101. Called only from `workflow-import.ts` (D50(a)).
 */
export function recordImport(db: Database, r: RecordImportInput): boolean {
  if (!available(db)) throw new Error("workflow import needs schema V101");
  const res = dbRun(
    db,
    `INSERT INTO workflow_import
       (signer_fingerprint, bundle_name, issued_at, bundle_sha256, steps_sha256, signer_pubkey,
        author_label, workflow_id, imported_at, import_count, approval_audit_id, import_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?,
             (SELECT COALESCE(MAX(import_seq), 0) + 1 FROM workflow_import))
     ON CONFLICT (signer_fingerprint, bundle_name) DO UPDATE SET
       issued_at = excluded.issued_at,
       bundle_sha256 = excluded.bundle_sha256,
       steps_sha256 = excluded.steps_sha256,
       signer_pubkey = excluded.signer_pubkey,
       author_label = excluded.author_label,
       workflow_id = excluded.workflow_id,
       imported_at = excluded.imported_at,
       import_count = workflow_import.import_count + 1,
       approval_audit_id = excluded.approval_audit_id,
       import_seq = excluded.import_seq
     WHERE excluded.issued_at >= workflow_import.issued_at`,
    [
      r.signerFingerprint,
      r.bundleName,
      r.issuedAt,
      r.bundleSha256,
      r.stepsSha256,
      r.signerPubkey,
      r.authorLabel,
      r.workflowId,
      r.importedAt,
      r.approvalAuditId,
    ],
  );
  return res.changes > 0;
}
