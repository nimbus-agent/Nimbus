/**
 * V96 - alert sources, deployment edge types and the one-shot regraph marker (Phase 10 IC2,
 * incident-engine spec § 5.2).
 *
 * 1. Seeds `deployed` (deployment -> commit) and `built_by` (deployment -> CI run). `graph_relation.type`
 *    is an FK to `graph_relation_type(name)`, so the names must exist before any such edge is written.
 * 2. `idx_deployment_items_sha`: the reverse relink probes `deployment_items` by sha alone, and the
 *    existing `idx_deployment_items_provider_sha` leads with `provider`.
 * 3. The `regraph_pending_ic2` marker in `_meta`. A migration is SQL and cannot build the service
 *    resolver, so the gateway's boot re-grafts deployments, incidents, error issues and data-quality
 *    tests once (`graph/regraph-once.ts`) and deletes the marker. Raw SQL only: `ALLOWED_META_KEYS`
 *    guards the IPC-reachable `getMeta`/`setMeta`, and this key is deliberately not on it.
 *
 * Every statement is idempotent.
 */
export const INCIDENT_ALERT_SOURCES_V96_SQL = [
  `INSERT OR IGNORE INTO graph_relation_type (name, directed) VALUES ('deployed', 1), ('built_by', 1)`,
  `CREATE INDEX IF NOT EXISTS idx_deployment_items_sha ON deployment_items (sha)`,
  `INSERT OR IGNORE INTO _meta (key, value) VALUES ('regraph_pending_ic2', '1')`,
] as const;
