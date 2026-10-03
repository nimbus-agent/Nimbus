/**
 * V64 — on-call pushed briefs (spec 2026-10-02-oncall-pushed-brief-design.md § 2.4).
 * `pushed_brief.incident_id` is the PRIMARY KEY on purpose: one brief per incident, so the table
 * itself is the dedup and no time cursor exists to drift. `oncall_push_state` is a singleton
 * holding the boot-reconciled `enabled_at` (§ 4.1). Only `oncall-push/push-store.ts` names either.
 */
export const ONCALL_PUSH_V64_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS pushed_brief (
     incident_id    TEXT PRIMARY KEY,
     session_id     TEXT,
     status         TEXT NOT NULL CHECK (status IN ('ok','failed')),
     failure_code   TEXT,
     brief_markdown TEXT,
     brief_json     TEXT,
     created_at     INTEGER NOT NULL,
     delivery_json  TEXT NOT NULL DEFAULT '{}',
     retried_at     INTEGER
   ) WITHOUT ROWID`,
  "CREATE INDEX IF NOT EXISTS idx_pushed_brief_created_at ON pushed_brief (created_at)",
  `CREATE TABLE IF NOT EXISTS oncall_push_state (
     id         INTEGER PRIMARY KEY CHECK (id = 1),
     enabled_at INTEGER NOT NULL
   )`,
];
