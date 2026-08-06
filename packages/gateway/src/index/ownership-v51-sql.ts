/**
 * V50 is a PERMANENT NO-OP. The migration ladder applies steps in sequence, so
 * the 49→50 slot must exist for V51 to be reachable; this branch fills it and
 * claims nothing, bumping `user_version` and recording one ledger row.
 *
 * DO NOT BACKFILL THIS CONSTANT'S BODY. The runner applies a step only while
 * `PRAGMA user_version === step.fromVersion` (`migrations/runner.ts`), so once
 * this branch lands and any database reaches 51, the 49→50 step NEVER runs
 * again. Adding real DDL here would therefore reach fresh installs only and
 * silently split the schema between them and every upgraded database — with no
 * error at any point, because both ladders complete successfully.
 *
 * The HTTP-agents resolve-by-URL work (its PR 3), which this slot was originally
 * reserved for, must take a NEW version number (V52 or later) with its own step,
 * so its column, index and batched backfill reach both populations.
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
