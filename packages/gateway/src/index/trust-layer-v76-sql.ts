/**
 * V76 — the marketplace trust layer (Phase 9.5 project 3). Additive only.
 *
 * - `trust_feed_state`: the anti-rollback floor of the Nimbus trust feed (`trust.json`): its pinned root
 *   key, the highest sequence accepted and the SHA-256 of the document accepted at it, so a feed
 *   re-served at that sequence with different content is refused. First written by trust-layer PR 2.
 * - `trust_statement`: one row per accepted trust statement (revocation, takedown, rotation,
 *   verification), keyed by its id (SHA-256 of its signed bytes). Blocks are a monotonic union: no
 *   later fetch removes one. `signer_role` says whose authority it carries, and a registry-signed
 *   statement carries that registry's name and root fingerprint as its scope (and only it does: the
 *   CHECK). First written by trust-layer PR 2.
 * - `extension_registry.last_index_sha256` / `builtin_registry_state.last_index_sha256`: the hash of
 *   the index accepted at `last_sequence`, so an index re-served at that sequence with different
 *   content is refused (a force-pushed `gh-pages`). NULL until the next accepted fetch, which adopts
 *   the document it sees. Written from this PR on.
 * - `extension.publisher_key_fingerprint`: the fingerprint of the key that verified the installed copy,
 *   so sibling extensions of one publisher can be signed by different keys after a rotation. NULL until
 *   an async boot pass backfills it from the Vault (migrations cannot read the Vault). PR 3.
 * - `extension_run_grant.trust_ack_json`: the statement ids the owner acknowledged when re-approving
 *   a blocked extension; `'[]'` for every existing grant. PR 2.
 */
export const TRUST_LAYER_V76_SQL = [
  `CREATE TABLE IF NOT EXISTS trust_feed_state (
     name                 TEXT PRIMARY KEY,
     root_key             TEXT NOT NULL,
     last_sequence        INTEGER NOT NULL,
     last_document_sha256 TEXT NOT NULL,
     last_generated_at    TEXT NOT NULL,
     last_fetched_at      INTEGER,
     last_attempted_at    INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS trust_statement (
     statement_id           TEXT PRIMARY KEY,
     kind                   TEXT NOT NULL
       CHECK (kind IN ('key.revoke','extension.takedown','key.rotate','publisher.verified')),
     statement_json         TEXT NOT NULL,
     signer_fingerprint     TEXT NOT NULL,
     signer_role            TEXT NOT NULL CHECK (signer_role IN ('publisher','nimbus','registry')),
     scope_registry         TEXT,
     scope_root_fingerprint TEXT,
     source                 TEXT NOT NULL,
     publisher_id           TEXT NOT NULL,
     key_fingerprint        TEXT,
     to_key_fingerprint     TEXT,
     extension_id           TEXT,
     first_seen_at          INTEGER NOT NULL,
     CHECK (
       (signer_role = 'registry' AND scope_registry IS NOT NULL AND scope_root_fingerprint IS NOT NULL)
       OR (signer_role IN ('publisher','nimbus') AND scope_registry IS NULL AND scope_root_fingerprint IS NULL)
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_trust_statement_publisher ON trust_statement(publisher_id, kind)`,
  `CREATE INDEX IF NOT EXISTS idx_trust_statement_extension ON trust_statement(extension_id)
     WHERE extension_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_trust_statement_source ON trust_statement(source)`,
  `ALTER TABLE extension_registry ADD COLUMN last_index_sha256 TEXT`,
  `ALTER TABLE builtin_registry_state ADD COLUMN last_index_sha256 TEXT`,
  `ALTER TABLE extension ADD COLUMN publisher_key_fingerprint TEXT`,
  `ALTER TABLE extension_run_grant ADD COLUMN trust_ack_json TEXT NOT NULL DEFAULT '[]'`,
] as const;
