/**
 * V93 - morning briefing runs and deadline notices (Phase 10 MB5, morning-briefing spec § 5.5).
 *
 * `briefing_run`: one row per briefing the gateway composed (or skipped, or failed to compose). Written
 * only by `briefing/briefing-store.ts`. Two columns are additions to the spec's table:
 *   - `slot_at`   the scheduled instant a `schedule` run or skip answers (NULL for a `manual` run). A
 *                 partial UNIQUE index makes one slot fire at most once even if two ticks race, and
 *                 `MAX(slot_at)` is the durable "last fire" the scheduler plans from.
 *   - `error_msg` the error name and first 200 characters of a `failed` run's message.
 * How a run started is `fired_by`, not `trigger`: static D44(d) reserves `trigger: "schedule"` to the
 * workflow scheduler, and a briefing run is not a workflow run.
 *
 * `deadline_notice`: the one OS notification already shown for an item's due date (item id, the RAW
 * due instant it was shown for, when). `item` is not a foreign-key parent, so the `AFTER DELETE ON item`
 * trigger is the cascade (an upsert is `ON CONFLICT DO UPDATE` and never fires it).
 *
 * Backfill: none. Neither table existed before this version.
 */
export const BRIEFING_V93_SQL = [
  `CREATE TABLE IF NOT EXISTS briefing_run (
  id TEXT PRIMARY KEY,
  fired_at INTEGER NOT NULL,
  fired_by TEXT NOT NULL CHECK (fired_by IN ('schedule','manual')),
  status TEXT NOT NULL CHECK (status IN ('ok','skipped','failed')),
  headline TEXT NOT NULL,
  markdown TEXT,
  counts_json TEXT,
  toast_outcome TEXT,
  slot_at INTEGER,
  error_msg TEXT
)`,
  "CREATE UNIQUE INDEX IF NOT EXISTS briefing_run_slot ON briefing_run (slot_at) WHERE slot_at IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS briefing_run_fired ON briefing_run (fired_at DESC)",
  `CREATE TABLE IF NOT EXISTS deadline_notice (
  item_id TEXT PRIMARY KEY,
  due_at_ms INTEGER NOT NULL,
  notified_at INTEGER NOT NULL
)`,
  `CREATE TRIGGER IF NOT EXISTS deadline_notice_item_delete AFTER DELETE ON item
BEGIN
  DELETE FROM deadline_notice WHERE item_id = OLD.id;
END`,
];
