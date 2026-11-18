/**
 * V105 - installed copies carry their offline-verified build provenance (S4 carried-in row, owner
 * rulings OR-PROV-1 to OR-PROV-5; invariant I51 bound 6).
 *
 * `extension.provenance_json`: the record a registry install kept of the version's provenance and of
 * the offline re-check it ran (`{ v: 1, version, registry, packageSha256, provenance, recheck,
 * checkedAt }`). `extension.provenance_bundle`: the Sigstore bundle itself (canonical JSON, at most
 * 64 KiB), stored only when it was fetched and matched the signed index, so `nimbus extension
 * verify-provenance` can re-check it offline later. Both nullable: a local install, a registry
 * install with no provenance and every row from before V105 have neither. Stored in the row rather
 * than as a file, so nothing can be planted beside it and it is deleted with the row.
 *
 * Written ONLY by `extensions/registry/installed-provenance.ts` (a source pin). Backfill: none.
 * Guarded by a column probe in the step: SQLite has no `ADD COLUMN IF NOT EXISTS`, and a step must
 * be re-runnable (the suites rewind `user_version`).
 */
export const EXTENSION_PROVENANCE_V105_SQL = [
  "ALTER TABLE extension ADD COLUMN provenance_json TEXT",
  "ALTER TABLE extension ADD COLUMN provenance_bundle TEXT",
];
