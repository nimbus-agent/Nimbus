/**
 * V71 — extension registries the owner subscribed to, and where an installed extension came from.
 * `extension_registry` pins a registry's root key (TOFU, fingerprint shown at add time) and the
 * newest index it has accepted (`last_sequence`/`last_generated_at`, the rollback anchor). The
 * three `extension` columns stay NULL for a local-path install. Removing a registry deletes only
 * its row: installed extensions keep their source columns, which are provenance, not a link.
 */
export const EXTENSION_REGISTRY_V71_SQL = [
  `CREATE TABLE IF NOT EXISTS extension_registry (
     name              TEXT PRIMARY KEY,
     url               TEXT NOT NULL UNIQUE,
     root_key          TEXT NOT NULL,
     root_fingerprint  TEXT NOT NULL,
     last_sequence     INTEGER NOT NULL,
     last_generated_at TEXT NOT NULL,
     added_at          INTEGER NOT NULL,
     last_fetched_at   INTEGER
   )`,
  `ALTER TABLE extension ADD COLUMN source_registry TEXT`,
  `ALTER TABLE extension ADD COLUMN source_root_fingerprint TEXT`,
  `ALTER TABLE extension ADD COLUMN source_channel TEXT CHECK(source_channel IN ('stable','beta'))`,
] as const;
