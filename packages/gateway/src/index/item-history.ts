import type { Database } from "bun:sqlite";

import { dbRun } from "../db/write.ts";
import {
  type ItemHistorySpec,
  normalizeHistoryValue,
  sourceAtFor,
  specFor,
} from "./item-history-keys.ts";

/**
 * The ONLY module with a write verb on `item_history` (Phase 10 IC1, schema V94, static D46(b)).
 *
 * Callers: `upsertIndexedItem` (read-before, then record), `deleteItemByPrimaryKey` (`__deleted`),
 * `deleteAllItemsForService` / `runDataDelete` (an owner erasure removes the service's rows) and the
 * retention tick (batched prune). Nothing here imports `item-store.ts`; it imports this module.
 *
 * Cost bound: an untracked `(service, type)` pays one `Map.get` and no statement; a tracked upsert pays one
 * primary-key read, at most two `JSON.parse` and at most one INSERT per tracked key.
 */

export const CREATED_KEY = "__created";
export const DELETED_KEY = "__deleted";

/** What `readItemHistoryBefore` saw: the spec of the tracked pair and the row as it stood before the write. */
export type ItemHistoryBefore =
  | { readonly spec: ItemHistorySpec; readonly existed: false }
  | { readonly spec: ItemHistorySpec; readonly existed: true; readonly metadata: string | null };

export type ItemHistoryNext = {
  readonly id: string;
  readonly service: string;
  readonly type: string;
  /** The metadata JSON exactly as it is about to be stored. */
  readonly metadata: string;
  readonly syncedAt: number;
};

/** `undefined` (and NO query) when the pair is untracked. */
export function readItemHistoryBefore(
  db: Database,
  id: string,
  service: string,
  type: string,
): ItemHistoryBefore | undefined {
  const spec = specFor(service, type);
  if (spec === undefined) return undefined;
  const row = db.query("SELECT metadata FROM item WHERE id = ?").get(id) as {
    metadata: string | null;
  } | null;
  if (row === null) return { spec, existed: false };
  return { spec, existed: true, metadata: row.metadata };
}

function parseMetadata(text: string | null): Record<string, unknown> | undefined {
  if (text === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}

function insertRow(
  db: Database,
  r: {
    itemId: string;
    service: string;
    type: string;
    key: string;
    oldValue: string | null;
    newValue: string | null;
    observedAtMs: number;
    sourceAtMs: number | null;
  },
): void {
  dbRun(
    db,
    `INSERT INTO item_history
       (item_id, service, type, key, old_value, new_value, observed_at_ms, source_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [r.itemId, r.service, r.type, r.key, r.oldValue, r.newValue, r.observedAtMs, r.sourceAtMs],
  );
}

/**
 * Records what an upsert changed. No prior row writes one `__created` row and no per-key rows (a first
 * observation is a baseline, not a change). An unchanged metadata string writes nothing and parses nothing.
 * A key absent from the new metadata records nothing unless the spec says the mapper writes it `always`.
 */
export function recordItemUpsertHistory(
  db: Database,
  before: ItemHistoryBefore,
  next: ItemHistoryNext,
): void {
  const base = { itemId: next.id, service: next.service, type: next.type };
  if (!before.existed) {
    insertRow(db, {
      ...base,
      key: CREATED_KEY,
      oldValue: null,
      newValue: null,
      observedAtMs: next.syncedAt,
      sourceAtMs: null,
    });
    return;
  }
  if (before.metadata === next.metadata) return;
  // A row we cannot read is "no information", never a throw into a sync.
  const oldMeta = parseMetadata(before.metadata);
  if (oldMeta === undefined) return;
  const newMeta = JSON.parse(next.metadata) as Record<string, unknown>;
  for (const k of before.spec.keys) {
    const nv = normalizeHistoryValue(newMeta[k.key]);
    if (nv === undefined && k.always !== true) continue;
    const newValue = nv ?? null;
    const oldValue = normalizeHistoryValue(oldMeta[k.key]) ?? null;
    if (oldValue === newValue) continue;
    insertRow(db, {
      ...base,
      key: k.key,
      oldValue,
      newValue,
      observedAtMs: next.syncedAt,
      sourceAtMs: sourceAtFor(before.spec, k.key, newValue, newMeta),
    });
  }
}

/** One `__deleted` row for a tracked item about to be deleted upstream; nothing for an untracked pair. */
export function recordItemDeleteHistory(
  db: Database,
  item: { readonly id: string; readonly service: string; readonly type: string },
  nowMs: number,
): void {
  if (specFor(item.service, item.type) === undefined) return;
  insertRow(db, {
    itemId: item.id,
    service: item.service,
    type: item.type,
    key: DELETED_KEY,
    oldValue: null,
    newValue: null,
    observedAtMs: nowMs,
    sourceAtMs: null,
  });
}

/** An owner erasure (`connector remove`, `nimbus data delete`): the service's change log goes with it. */
export function deleteItemHistoryForService(db: Database, service: string): void {
  dbRun(db, "DELETE FROM item_history WHERE service = ?", [service]);
}

export type ItemHistoryPruneResult = {
  readonly deleted: number;
  readonly batches: number;
  /** True when the run stopped at `maxBatches` with the last batch full (more rows may remain). */
  readonly more: boolean;
};

/**
 * Deletes rows with `observed_at_ms < cutoffMs` in batches of `batchSize`, at most `maxBatches` of them.
 * Each batch is ONE statement served by `item_history_observed`.
 */
export function pruneItemHistory(
  db: Database,
  opts: { readonly cutoffMs: number; readonly batchSize: number; readonly maxBatches: number },
): ItemHistoryPruneResult {
  let deleted = 0;
  let batches = 0;
  let lastFull = false;
  while (batches < opts.maxBatches) {
    const r = dbRun(
      db,
      `DELETE FROM item_history WHERE id IN (
         SELECT id FROM item_history WHERE observed_at_ms < ? ORDER BY observed_at_ms LIMIT ?)`,
      [opts.cutoffMs, opts.batchSize],
    );
    batches += 1;
    deleted += r.changes;
    lastFull = r.changes === opts.batchSize;
    if (!lastFull) break;
  }
  return { deleted, batches, more: lastFull };
}
