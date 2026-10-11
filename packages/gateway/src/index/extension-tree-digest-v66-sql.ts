/**
 * V66 — a digest over every file of an installed extension (extension-runtime design § 4.6).
 * NULL for every row that predates this migration: those packages were hashed by manifest and entry
 * only, and their remaining files are not trusted until the owner re-adopts them with
 * `nimbus extension rehash`, which is gated like an install.
 */
export const EXTENSION_TREE_DIGEST_V66_SQL = [
  `ALTER TABLE extension ADD COLUMN tree_digest TEXT`,
] as const;
