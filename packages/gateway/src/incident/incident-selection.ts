import type { Database } from "bun:sqlite";

import { codeUnitCompare } from "./lanes/caps.ts";
import { qualifiesSql, type TriggerConfig } from "./trigger-facts.ts";
import { type TriggerService, triggerTypeOf } from "./trigger-sources.ts";

/**
 * Which trigger items the engine assembles on a pass (Phase 10 IC3, design B). Read-only SQL; the engine owns
 * the order (N, then R, then C) and the 20-record cap.
 *
 * - N (new): items of the service with NO record, modified within `lookbackMs`, whose severity QUALIFIES,
 *   filtered IN SQL before the 200-row cap (a cap that ran first would let non-qualifying items hide qualifying
 *   ones for ever). Status is not a filter: a P1 that fired and resolved between two syncs is assembled once.
 * - R (refresh): open or unknown records, least recently CHECKED first, so an unchanged record goes to the back.
 * - C (changed): closed records whose item changed since their last check (and not in the future).
 */

export const SELECT_NEW_CAP = 200;
export const SELECT_CHANGED_CAP = 200;

export function selectNewItemIds(
  db: Database,
  service: TriggerService,
  config: TriggerConfig,
  sinceMs: number,
): string[] {
  const q = qualifiesSql(service, config, "i");
  const rows = db
    .query(
      `SELECT i.id FROM item i
        WHERE i.service = ? AND i.type = ? AND i.modified_at >= ? AND ${q.clause}
          AND NOT EXISTS (SELECT 1 FROM incident_record r WHERE r.trigger_item_id = i.id)
        ORDER BY i.modified_at DESC, i.id ASC LIMIT ${String(SELECT_NEW_CAP)}`,
    )
    .all(service, triggerTypeOf(service), sinceMs, ...q.params) as { id: string }[];
  return rows.map((r) => r.id);
}

type CheckedRow = { trigger_item_id: string; checked_at_ms: number; id: string };

/** Open and unknown records of the service, least recently checked first (two single-status reads, merged). */
export function selectRefreshItemIds(
  db: Database,
  service: TriggerService,
  limit: number,
): string[] {
  const q = db.query(
    `SELECT trigger_item_id, checked_at_ms, id FROM incident_record
      WHERE status = ? AND trigger_service = ? ORDER BY checked_at_ms ASC, id ASC LIMIT ?`,
  );
  const rows = [
    ...(q.all("open", service, limit) as CheckedRow[]),
    ...(q.all("unknown", service, limit) as CheckedRow[]),
  ];
  rows.sort((a, b) =>
    a.checked_at_ms === b.checked_at_ms
      ? codeUnitCompare(a.id, b.id)
      : a.checked_at_ms - b.checked_at_ms,
  );
  return rows.slice(0, limit).map((r) => r.trigger_item_id);
}

export function selectChangedItemIds(
  db: Database,
  service: TriggerService,
  nowMs: number,
): string[] {
  const rows = db
    .query(
      `SELECT r.trigger_item_id AS id FROM incident_record r JOIN item i ON i.id = r.trigger_item_id
        WHERE r.trigger_service = ? AND r.status = 'closed'
          AND i.modified_at > r.checked_at_ms AND i.modified_at <= ?
        ORDER BY r.checked_at_ms ASC, r.id ASC LIMIT ${String(SELECT_CHANGED_CAP)}`,
    )
    .all(service, nowMs) as { id: string }[];
  return rows.map((r) => r.id);
}
