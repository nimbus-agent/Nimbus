import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import { TRIGGER_SOURCES, type TriggerService } from "./trigger-sources.ts";

/**
 * Record ids (Phase 10 IC3). `inc_` plus the first 16 hex characters of SHA-256 of the trigger item id:
 * deterministic, so a re-assembly after a pruned row recreates the same id. The UNIQUE column on
 * `trigger_item_id` makes a collision a hard error, never silent sharing.
 */
export function incidentIdFor(triggerItemId: string): string {
  return `inc_${createHash("sha256").update(triggerItemId, "utf8").digest("hex").slice(0, 16)}`;
}

export type IncidentRef =
  | { readonly kind: "record"; readonly recordId: string; readonly triggerItemId: string }
  | { readonly kind: "item"; readonly triggerItemId: string; readonly service: TriggerService }
  | { readonly kind: "ambiguous"; readonly candidates: readonly string[] }
  | { readonly kind: "not_a_trigger"; readonly itemId: string }
  | { readonly kind: "none" };

type ItemRow = { id: string; service: string; type: string };

function triggerPairClause(): { sql: string; params: string[] } {
  const parts = TRIGGER_SOURCES.map(() => "(service = ? AND type = ?)");
  return {
    sql: `(${parts.join(" OR ")})`,
    params: TRIGGER_SOURCES.flatMap((s) => [s.service, s.type]),
  };
}

function asRef(db: Database, row: ItemRow): IncidentRef {
  const found = TRIGGER_SOURCES.find((s) => s.service === row.service && s.type === row.type);
  if (found === undefined) return { kind: "not_a_trigger", itemId: row.id };
  const rec = db.query("SELECT id FROM incident_record WHERE trigger_item_id = ?").get(row.id) as {
    id: string;
  } | null;
  return rec === null
    ? { kind: "item", triggerItemId: row.id, service: found.service }
    : { kind: "record", recordId: rec.id, triggerItemId: row.id };
}

/**
 * Resolve what a person typed: a record id, then a trigger item id, then a provider id (the item's
 * `external_id`, among the trigger item types). Every comparison is an equality on a bound value, so a
 * LIKE metacharacter in the input matches literally. A provider id that names two items is ambiguous
 * and returns the candidate item ids.
 */
export function resolveIncidentRef(db: Database, ref: string): IncidentRef {
  const byRecord = db
    .query("SELECT id, trigger_item_id FROM incident_record WHERE id = ?")
    .get(ref) as { id: string; trigger_item_id: string } | null;
  if (byRecord !== null) {
    return { kind: "record", recordId: byRecord.id, triggerItemId: byRecord.trigger_item_id };
  }
  const byTrigger = db
    .query("SELECT id, trigger_item_id FROM incident_record WHERE trigger_item_id = ?")
    .get(ref) as { id: string; trigger_item_id: string } | null;
  // A retained record whose item left the index (an upstream delete) is still found by its trigger item id.
  if (byTrigger !== null) {
    return { kind: "record", recordId: byTrigger.id, triggerItemId: byTrigger.trigger_item_id };
  }
  const byItem = db
    .query("SELECT id, service, type FROM item WHERE id = ?")
    .get(ref) as ItemRow | null;
  if (byItem !== null) return asRef(db, byItem);
  const pairs = triggerPairClause();
  const byProvider = db
    .query(
      `SELECT id, service, type FROM item WHERE external_id = ? AND ${pairs.sql} ORDER BY id ASC LIMIT 10`,
    )
    .all(ref, ...pairs.params) as ItemRow[];
  if (byProvider.length === 0) return { kind: "none" };
  const [only] = byProvider;
  if (byProvider.length === 1 && only !== undefined) return asRef(db, only);
  return { kind: "ambiguous", candidates: byProvider.map((r) => r.id) };
}
