/**
 * V81 — locally observed extension network evidence (quality layer).
 *
 * `extension_network_observation`: one row per (extension, version, destination, port, outcome)
 * with a count and first/last seen. `extension_observation_coverage`: what was watched, per
 * (extension, version): runs, milliseconds, the OS, whether network was observable, and whether a
 * run's observation stopped at its one-day bound (1440 window files).
 * `extension_observation_applied`: which window files have been applied, keyed by the run
 * (`<serviceId>.<runStartMs>.<8 hex>`, the file prefix) and the window's seq, so a file applied
 * once never counts again, even when deleting it failed or the gateway crashed before the delete.
 * All three cascade with the `extension` row. Nothing here is read to make an enforcement decision.
 *
 * Backfill: none. Nothing was observed before this version.
 */
export const EXTENSION_OBSERVATION_V81_SQL = [
  `CREATE TABLE IF NOT EXISTS extension_network_observation (
  extension_id TEXT NOT NULL REFERENCES extension(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  destination TEXT NOT NULL,
  port INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('used','refused','unmatched')),
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (extension_id, version, destination, port, outcome)
)`,
  `CREATE TABLE IF NOT EXISTS extension_observation_coverage (
  extension_id TEXT NOT NULL REFERENCES extension(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  os TEXT NOT NULL CHECK (os IN ('linux','darwin','win32')),
  runs INTEGER NOT NULL,
  observed_ms INTEGER NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  dropped INTEGER NOT NULL,
  network_observed INTEGER NOT NULL CHECK (network_observed IN (0,1)),
  stopped INTEGER NOT NULL DEFAULT 0 CHECK (stopped IN (0,1)),
  PRIMARY KEY (extension_id, version)
)`,
  `CREATE TABLE IF NOT EXISTS extension_observation_applied (
  run_key TEXT NOT NULL,
  seq INTEGER NOT NULL,
  extension_id TEXT NOT NULL REFERENCES extension(id) ON DELETE CASCADE,
  applied_at INTEGER NOT NULL,
  PRIMARY KEY (run_key, seq)
)`,
] as const;
