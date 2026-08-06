/**
 * V50 is RESERVED for the HTTP-agents PR 3 (`resolve_key`), which is being
 * built on a parallel branch. The migration ladder applies steps in sequence,
 * so the slot must exist for V51 to be reachable — but this branch must not
 * claim it. The step is therefore a deliberate no-op: it bumps
 * `user_version` and records a ledger row, nothing else. PR 3 replaces this
 * constant's body with its real DDL; the version and ledger row are already
 * correct.
 */
export const SCHEMA_V50_RESERVED_SQL = `
-- V50 reserved for the HTTP agents resolve-by-URL work; intentionally empty.
SELECT 1;
`;

/**
 * V51 — seed the ownership relation types (Spine S1, ownership graph).
 * `graph_relation.type` is FK-constrained to `graph_relation_type(name)`, so
 * these must exist before any ownership edge can be inserted. Mirrors
 * `graph-lineage-types-v40-sql.ts`.
 */
export const OWNERSHIP_RELATION_TYPES_V51_SQL = `
INSERT OR IGNORE INTO graph_relation_type (name, directed) VALUES
  ('owns', 1),
  ('contains', 1),
  ('tracks_remote', 1);
`;

/**
 * Single-row pass state. Every counter exists to make a documented limit
 * REPORTABLE rather than implied: `roots_total = 0` is the most common cause
 * of an empty ownership graph and must be visible, not silent. The
 * `CHECK(id = 1)` shape follows `decision_pass_state`
 * (`decisions-v47-sql.ts:93`).
 */
export const OWNERSHIP_PASS_STATE_V51_SQL = `
CREATE TABLE IF NOT EXISTS ownership_pass_state (
  id                INTEGER PRIMARY KEY CHECK(id = 1),
  last_pass_at      INTEGER,
  last_duration_ms  INTEGER NOT NULL DEFAULT 0,
  roots_total       INTEGER NOT NULL DEFAULT 0,
  roots_covered     INTEGER NOT NULL DEFAULT 0,
  roots_with_remote INTEGER NOT NULL DEFAULT 0,
  files_covered     INTEGER NOT NULL DEFAULT 0,
  files_excluded    INTEGER NOT NULL DEFAULT 0,
  services_bound    INTEGER NOT NULL DEFAULT 0,
  owners_emitted    INTEGER NOT NULL DEFAULT 0,
  entities_reaped   INTEGER NOT NULL DEFAULT 0
);
`;
