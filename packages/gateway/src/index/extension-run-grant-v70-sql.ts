/**
 * V70 — what the local owner approved an installed extension to RUN with (extension-runtime design
 * § 4.4, amended § 11). One row per extension; the row binds to bytes (`tree_digest`, `version`) and
 * to resolved grants (`permissions_json`), never to a name. `service_id` is computed once and
 * stored, never recomputed. The cascade fires only on a connection with `foreign_keys = ON`
 * (LocalIndex sets it; another connection may not), so `deleteExtensionById` deletes the grant
 * explicitly rather than relying on it. Only this file and
 * `extensions/run-grant-store.ts` name the table (static rule D33(b)).
 */
export const EXTENSION_RUN_GRANT_V70_SQL = [
  `CREATE TABLE IF NOT EXISTS extension_run_grant (
     extension_id     TEXT PRIMARY KEY REFERENCES extension(id) ON DELETE CASCADE,
     service_id       TEXT NOT NULL UNIQUE,
     version          TEXT NOT NULL,
     tree_digest      TEXT NOT NULL,
     permissions_json TEXT NOT NULL,
     model_access     INTEGER NOT NULL DEFAULT 0 CHECK(model_access IN (0, 1)),
     approved_at      INTEGER NOT NULL
   )`,
] as const;
