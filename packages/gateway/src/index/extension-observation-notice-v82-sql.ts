/**
 * V82 — the observation notification's rate state (quality layer).
 *
 * `extension_observation_notice`: when the owner was last notified that observation found an
 * extension version reaching beyond what it declared, so at most one notification goes out per
 * extension and version per 24 hours, whatever the number of findings. Cascades with the
 * `extension` row; also deleted explicitly by `deleteObservationsFor`, and aged out 90 days after
 * `last_notified_at`. Nothing here is read to make an enforcement decision.
 *
 * Backfill: none. Nothing was notified before this version.
 */
export const EXTENSION_OBSERVATION_NOTICE_V82_SQL = [
  `CREATE TABLE IF NOT EXISTS extension_observation_notice (
  extension_id TEXT NOT NULL REFERENCES extension(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  last_notified_at INTEGER NOT NULL,
  PRIMARY KEY (extension_id, version)
)`,
] as const;
