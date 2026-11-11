/**
 * V88 — standing approval rules (Phase 10 SA3, invariant I55, spec § 5.2).
 *
 * `standing_rule`: one owner-approved rule that lets ONE write step of ONE workflow, at one content
 * hash, run without a per-call prompt, for a bounded time and a bounded number of actions.
 * `standing_rule_fire`: one row per action the rule approved, written in the SAME transaction as the
 * counter claim (`standing/standing-rule-store.ts`, the only writer of both tables, static D44(b)).
 * The audit and egress rows of a standing-approved action carry the `fire_id`, so the link runs from
 * those rows to the fire, never the other way.
 *
 * Backfill: none. No rule existed before this version.
 *
 * Schedule columns (spec § 6.2 lists them here) are NOT in this version: they belong to the
 * scheduler and arrive with it as V89. Nothing depends on the split.
 */
export const STANDING_RULE_V88_SQL = [
  `CREATE TABLE IF NOT EXISTS standing_rule (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  workflow_id TEXT NOT NULL,
  workflow_sha256 TEXT NOT NULL,
  step_index INTEGER NOT NULL CHECK (step_index >= 0),
  action_type TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  window_json TEXT,
  expires_at INTEGER NOT NULL,
  max_actions INTEGER NOT NULL CHECK (max_actions BETWEEN 1 AND 500),
  actions_used INTEGER NOT NULL DEFAULT 0,
  paused_at INTEGER,
  revoked_at INTEGER,
  last_fired_at INTEGER,
  approval_audit_id INTEGER NOT NULL,
  CHECK (actions_used >= 0 AND actions_used <= max_actions),
  CHECK (expires_at > created_at)
)`,
  `CREATE INDEX IF NOT EXISTS idx_standing_rule_workflow ON standing_rule (workflow_id, workflow_sha256)`,
  `CREATE TABLE IF NOT EXISTS standing_rule_fire (
  fire_id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL REFERENCES standing_rule(id),
  fired_at INTEGER NOT NULL,
  action_type TEXT NOT NULL,
  matched_scope_sha256 TEXT NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_standing_rule_fire_rule ON standing_rule_fire (rule_id, fired_at)`,
] as const;
