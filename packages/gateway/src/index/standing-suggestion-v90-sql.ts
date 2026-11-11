/**
 * V90 — approval learning (Phase 10 SA5, spec § 6.4).
 *
 * `standing_streak`: per (workflow id, content hash, step) the number of consecutive owner-started
 * runs in which the owner approved every asked action of that write step by hand. `standing_suggestion`:
 * the rule suggestion Nimbus records when a streak reaches `[standing] suggest_after`. Both are
 * written only by `standing/standing-suggestion-store.ts` (static D44(f)); neither grants anything,
 * and a suggestion becomes a rule only through the owner's `standing.rule.create` approval.
 *
 * Backfill: none. No streak or suggestion existed before this version.
 */
export const STANDING_SUGGESTION_V90_SQL = [
  `CREATE TABLE IF NOT EXISTS standing_streak (
  workflow_id TEXT NOT NULL,
  workflow_sha256 TEXT NOT NULL,
  step_index INTEGER NOT NULL CHECK (step_index >= 0),
  streak INTEGER NOT NULL CHECK (streak >= 0),
  last_run_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workflow_id, workflow_sha256, step_index)
)`,
  `CREATE TABLE IF NOT EXISTS standing_suggestion (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  workflow_id TEXT NOT NULL,
  workflow_sha256 TEXT NOT NULL,
  step_index INTEGER NOT NULL CHECK (step_index >= 0),
  streak INTEGER NOT NULL CHECK (streak >= 0),
  status TEXT NOT NULL CHECK (status IN ('open','accepted','dismissed','stale')),
  rule_id TEXT,
  closed_at INTEGER
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_standing_suggestion_open
   ON standing_suggestion (workflow_id, workflow_sha256, step_index) WHERE status = 'open'`,
] as const;
