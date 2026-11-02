/**
 * V80 — the floor for a registry's `liveness.json` (quality layer).
 *
 * One row per registry name: the key the index named when the file was accepted, the highest
 * sequence accepted, the digest of the document accepted at it, and when. It refuses a replayed
 * lower sequence and different content at an accepted one, like the index and trust-feed floors.
 *
 * Backfill: none. Nothing was verified before this version.
 */
export const REGISTRY_LIVENESS_V80_SQL = [
  `CREATE TABLE IF NOT EXISTS registry_liveness_state (
  registry TEXT PRIMARY KEY,
  liveness_key TEXT NOT NULL,
  last_sequence INTEGER NOT NULL,
  last_document_sha256 TEXT NOT NULL,
  last_generated_at TEXT NOT NULL,
  last_fetched_at INTEGER NOT NULL
)`,
] as const;
