/**
 * V52 — `item.resolve_key`: the derived, indexed key that `GET /v1/items/resolve` matches on.
 *
 * A DERIVED column rather than an index on `canonical_url` directly, because the stored values are
 * raw provider URLs while the incoming value is whatever is in a browser's address bar. Matching
 * those needs normalisation on BOTH sides, and SQLite cannot run `canonicalizeUrl`.
 *
 * Nullable with no DEFAULT: a row with neither `url` nor `canonical_url` has no key, and NULL is
 * the honest value. SQLite indexes skip NULLs, so those rows cost nothing.
 */
export const RESOLVE_KEY_V52_SQL: readonly string[] = Object.freeze([
  `ALTER TABLE item ADD COLUMN resolve_key TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_item_resolve_key ON item(resolve_key)`,
]);
