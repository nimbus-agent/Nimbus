import type { Database } from "bun:sqlite";
import { emptyBlocks, type FreeBusyWindow, markBusy } from "./free-busy-blocks.ts";

/**
 * The owner's busy blocks from the LOCAL index (Phase 10, OR-S4-SCHED). The read selects the
 * `metadata` column of calendar `event` rows and nothing else, so a title, a link or an id cannot
 * reach this module's result; of the metadata it reads only the five keys the shared normalizer
 * writes for every provider (`start_ms`, `end_ms`, `all_day`, `status`, `self_response`). An
 * attendee, an organiser, a place and a calendar name are never read.
 *
 * How an event counts (stated in the I17 (b) text of docs/SECURITY-INVARIANTS.md):
 *   - cancelled, or declined by the owner: free;
 *   - tentative, or an invitation not yet answered: BUSY (the reply must not tell a tentative
 *     meeting from an accepted one, and a false "free" costs more than a false "busy");
 *   - all-day: free (a holiday, a birthday or a reminder banner; the index cannot tell these from
 *     an out-of-office, so a person who blocks a day says so with timed events);
 *   - no usable start and end: skipped and counted (`unreadable`), never guessed.
 */

export const CALENDAR_SERVICES = ["apple", "google_calendar", "outlook"] as const;
export const SCAN_CAP = 20_000;
/** A connected calendar whose last sync is older than this is not trusted to say "free". */
export const MAX_SYNC_AGE_MS = 24 * 3_600_000;

type Meta = Record<string, unknown>;

export type BusyRead = {
  readonly blocks: Uint8Array;
  readonly scanned: number;
  readonly unreadable: number;
  readonly capped: boolean;
};

/**
 * `ready` only when at least one calendar service is connected and EVERY connected one synced
 * within `MAX_SYNC_AGE_MS`. Without it an empty index would answer "free all day".
 *
 * A service counts as connected when its `sync_state` row says a credential is configured (the
 * scheduler writes that flag every tick, so a newly connected calendar has a row, with no sync
 * yet, within one tick), OR when events of that service are already indexed: indexed events with
 * no configured health row are data of unknown age, never a calendar to ignore.
 */
export function calendarReadiness(db: Database, nowMs: number): "ready" | "not_ready" {
  const q = db.query(
    "SELECT last_sync_at, configured FROM sync_state WHERE connector_id = ? LIMIT 1",
  );
  const hasEvents = db.query(
    "SELECT 1 AS x FROM item WHERE type = 'event' AND service = ? LIMIT 1",
  );
  let connected = 0;
  for (const id of CALENDAR_SERVICES) {
    const row = q.get(id) as { last_sync_at: number | null; configured: number } | null;
    const configured = row !== null && row.configured !== 0;
    if (!configured && hasEvents.get(id) === null) continue;
    connected += 1;
    const last = row?.last_sync_at ?? null;
    if (last === null || nowMs - last > MAX_SYNC_AGE_MS) return "not_ready";
  }
  return connected > 0 ? "ready" : "not_ready";
}

function parseMeta(json: string | null): Meta | null {
  if (json === null) return null;
  try {
    const v = JSON.parse(json) as unknown;
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Meta) : null;
  } catch {
    return null;
  }
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Applies one event's metadata to the blocks; returns false when the row had no usable time. */
function applyEvent(meta: Meta, w: FreeBusyWindow, blocks: Uint8Array): boolean {
  // lane-census: scope=event service=apple,google_calendar,outlook
  const status = typeof meta["status"] === "string" ? meta["status"].toLowerCase() : "";
  // lane-census: scope=event service=apple,google_calendar,outlook
  const selfResponse = meta["self_response"];
  // lane-census: scope=event service=apple,google_calendar,outlook
  const startMs = num(meta["start_ms"]);
  // lane-census: scope=event service=apple,google_calendar,outlook
  const endMs = num(meta["end_ms"]);
  if (startMs === null || endMs === null) return false;
  // lane-census: scope=event service=apple,google_calendar,outlook
  const allDay = meta["all_day"] === true;
  if (allDay || status === "cancelled" || selfResponse === "declined") return true;
  markBusy(blocks, w, startMs, endMs);
  return true;
}

export function readBusyBlocks(db: Database, w: FreeBusyWindow): BusyRead {
  // The window filter runs in SQL BEFORE the scan cap. A row whose metadata is not JSON, or has no
  // numeric start and end, is kept so it is counted as unreadable rather than silently dropped.
  const rows = db
    .query(
      `SELECT metadata FROM item
        WHERE type = 'event' AND service IN ('apple','google_calendar','outlook')
          AND CASE
            WHEN NOT json_valid(metadata) THEN 1
            WHEN json_type(metadata, '$.start_ms') IN ('integer','real')
             AND json_type(metadata, '$.end_ms') IN ('integer','real') THEN
              json_extract(metadata, '$.start_ms') < ?1 AND json_extract(metadata, '$.end_ms') > ?2
            ELSE 1
          END
        ORDER BY modified_at DESC, id LIMIT ?3`,
    )
    .all(w.toMs, w.fromMs, SCAN_CAP + 1) as Array<{ metadata: string | null }>;
  const capped = rows.length > SCAN_CAP;
  const scanned = capped ? rows.slice(0, SCAN_CAP) : rows;
  const blocks = emptyBlocks(w);
  let unreadable = 0;
  for (const r of scanned) {
    const meta = parseMeta(r.metadata);
    if (meta === null || !applyEvent(meta, w, blocks)) unreadable += 1;
  }
  return { blocks, scanned: scanned.length, unreadable, capped };
}
