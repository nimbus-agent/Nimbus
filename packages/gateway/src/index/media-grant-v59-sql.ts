/**
 * V59 — durable, artifact-scoped remote-model grants (spec § 18.3).
 *
 * The unit of consent is (artifact, modality, vendor). There is deliberately no `'all'` vendor:
 * a wildcard is broader than anyone means when they approve one, and it would silently extend to
 * a vendor added after the grant was given. Authorising two vendors means two grants.
 *
 * `modality` retains `'av'` even though PR 4 grants only images, because the column outlives the
 * scope — a later remote STT tier writes `'av'` rows into this same table rather than migrating
 * it. The column is forward-looking; the WRITER is not, and `media-grant-store.ts` refuses to
 * write an `'av'` row in this release (§ 19.4).
 */
export const MEDIA_GRANT_V59_SQL = `
CREATE TABLE IF NOT EXISTS media_grant (
  id            TEXT PRIMARY KEY,
  item_id       TEXT NOT NULL,
  modality      TEXT NOT NULL CHECK (modality IN ('image', 'av')),
  model_vendor  TEXT NOT NULL,
  granted_at    INTEGER NOT NULL,
  revoked_at    INTEGER
) WITHOUT ROWID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_media_grant_active
  ON media_grant (item_id, modality, model_vendor)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_media_grant_item
  ON media_grant (item_id)
  WHERE revoked_at IS NULL;
`;
