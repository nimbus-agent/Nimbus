/**
 * V85 — the owner's approved IaC scope (Phase 9.7 D2, invariant I54).
 *
 * `connector_write_iac_grant`: what `nimbus connector writes enable iac` approved, one row per
 * value: `workdir` (a canonical absolute directory Terraform may run in), `cloud` (`aws`, `azure`,
 * `gcp`: whose credential and hosts the plan and apply children get), `region` (extra AWS regions
 * whose hosts are reachable) and `net` (extra hosts the owner typed, such as a state backend).
 * Written only by the HITL-gated `connector.writes.enable` handler, which replaces the whole set;
 * `disable iac` drops it. The runner reads it fresh for every child it starts.
 *
 * Backfill: none. Nothing was approved before this version, so no directory is runnable.
 */
export const CONNECTOR_WRITE_IAC_V85_SQL = [
  `CREATE TABLE IF NOT EXISTS connector_write_iac_grant (
  kind TEXT NOT NULL CHECK (kind IN ('workdir', 'cloud', 'region', 'net')),
  value TEXT NOT NULL,
  approved_at INTEGER NOT NULL,
  PRIMARY KEY (kind, value)
)`,
] as const;
