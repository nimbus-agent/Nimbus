/**
 * V69 — the owner's standing approval to RUN an installed extension (extension-runtime design
 * § 4.4). One row per extension, written only by `extension.approveRun` after the `extension.run`
 * HITL gate. The row binds the approval to the exact bytes approved (`version` + `tree_digest`) and
 * to the resolved permissions shown in the prompt, so a changed package or a changed manifest needs
 * a fresh approval. `service_id` is derived once, when the first grant is written, and kept across
 * re-approvals. `ON DELETE CASCADE` drops the grant with its extension; `extension.remove` also
 * deletes it explicitly, so the grant goes even on a connection with foreign keys off.
 */
export const EXTENSION_RUN_GRANT_V69_SQL = [
  `CREATE TABLE extension_run_grant (
    extension_id     TEXT PRIMARY KEY REFERENCES extension(id) ON DELETE CASCADE,
    service_id       TEXT NOT NULL UNIQUE,
    version          TEXT NOT NULL,
    tree_digest      TEXT NOT NULL,
    permissions_json TEXT NOT NULL,
    model_access     INTEGER NOT NULL DEFAULT 0 CHECK (model_access IN (0, 1)),
    approved_at      INTEGER NOT NULL
  )`,
] as const;
