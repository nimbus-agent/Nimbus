/**
 * V79 — what an installed extension IS (marketplace dependencies, PR 4: starter packs).
 *
 * `extension.kind` is `'extension'` for a package with code and `'starter-pack'` for a package of
 * dependencies with no code. It is written once at install (and again when an update replaces the
 * installed manifest), from the verified manifest, so run state, approval and spawn read a row
 * rather than re-reading the manifest.
 *
 * Backfill: none. Every row installed before this version is an extension: this gateway refused
 * starter packs until V79.
 */
export const EXTENSION_KIND_V79_SQL = [
  `ALTER TABLE extension ADD COLUMN kind TEXT NOT NULL DEFAULT 'extension' CHECK (kind IN ('extension', 'starter-pack'))`,
] as const;
