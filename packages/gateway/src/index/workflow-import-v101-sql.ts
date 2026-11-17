/**
 * V101 - signed workflow import provenance (I59, the signed workflow import slice).
 *
 * `workflow_import`: one row per (signer fingerprint, bundle name) that was ever imported. It is the
 * REPLAY FLOOR (`issued_at` is only ever raised, so deleting the workflow never lets an older signed
 * bundle back in) and the provenance `workflow list` shows. NO foreign key to `workflow`, by design: the
 * floor outlives the workflow, exactly as `item_history` outlives its item (V94).
 *
 * The primary key serves the floor lookup by (signer, name). `workflow_import_workflow` serves the
 * "newest provenance of this workflow" read, and `workflow_import_name` serves `signersForName` (which
 * signers ever imported a bundle with this name), whose leading column is `bundle_name`.
 *
 * `import_seq` is the transaction order of the last import that wrote the row (one more than the table's
 * maximum, set on every insert AND update). "Which signer supplied the current content" orders by it,
 * never by `imported_at` (a clock can step back) or by rowid (an upsert keeps its rowid).
 *
 * Written ONLY by `automation/workflow-import-store.ts` (static D50(a)). Backfill: none. Re-runnable
 * (IF NOT EXISTS only).
 */
export const WORKFLOW_IMPORT_V101_SQL = [
  `CREATE TABLE IF NOT EXISTS workflow_import (
  signer_fingerprint TEXT NOT NULL,
  bundle_name        TEXT NOT NULL,
  issued_at          INTEGER NOT NULL,
  bundle_sha256      TEXT NOT NULL,
  steps_sha256       TEXT NOT NULL,
  signer_pubkey      TEXT NOT NULL,
  author_label       TEXT,
  workflow_id        TEXT NOT NULL,
  imported_at        INTEGER NOT NULL,
  import_count       INTEGER NOT NULL DEFAULT 1,
  approval_audit_id  INTEGER NOT NULL,
  import_seq         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (signer_fingerprint, bundle_name),
  CHECK (length(signer_fingerprint) = 32),
  CHECK (length(steps_sha256) = 64 AND length(bundle_sha256) = 64)
)`,
  "CREATE INDEX IF NOT EXISTS workflow_import_workflow ON workflow_import (workflow_id)",
  "CREATE INDEX IF NOT EXISTS workflow_import_name ON workflow_import (bundle_name)",
] as const;
