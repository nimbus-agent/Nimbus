import type { Database } from "bun:sqlite";

import { deleteItemByPrimaryKey } from "./item-store.ts";

/**
 * The (service -> item types) a syncable may sweep with `replaceItemSet`. A service with no entry
 * cannot call it, and a listed service cannot name a type outside its list, so the capability can
 * never be pointed at (for example) `outlook` `email` rows. Phase 10 MB3 adds the on-call type here.
 */
export const REPLACE_ITEM_SET_TYPES: Readonly<Record<string, readonly string[]>> = {
  google_calendar: ["event"],
  outlook: ["event"],
};

/** A bug guard far above any run's keep set (Google: 20 calendars x 10 pages x 250 events). */
export const REPLACE_ITEM_SET_MAX_KEEP = 20_000;

export type ReplaceItemSetOptions = {
  /**
   * A row is a candidate only when its metadata `end_ms` is a finite number below this. A row with
   * no `end_ms` (or a non-number one) is never a candidate under it.
   */
  readonly endBeforeMs?: number;
  /** A row is a candidate only when its `external_id` starts with this (a JS `startsWith`, never `LIKE`). */
  readonly externalIdPrefix?: string;
};

type CandidateRow = { id: string; external_id: string; metadata: string | null };

function endMsOf(metadata: string | null): number | undefined {
  if (metadata === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(metadata);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const end = (parsed as Record<string, unknown>)["end_ms"];
    return typeof end === "number" && Number.isFinite(end) ? end : undefined;
  } catch {
    return undefined;
  }
}

function validate(
  service: string,
  type: string,
  keep: readonly string[],
  opts: ReplaceItemSetOptions,
): void {
  const allowed = REPLACE_ITEM_SET_TYPES[service];
  if (allowed === undefined) {
    throw new Error(`replaceItemSet is not available to "${service}".`);
  }
  if (!allowed.includes(type)) {
    throw new Error(`replaceItemSet may not sweep "${type}" rows of "${service}".`);
  }
  if (keep.length > REPLACE_ITEM_SET_MAX_KEEP) {
    throw new Error(
      `replaceItemSet keeps at most ${String(REPLACE_ITEM_SET_MAX_KEEP)} external ids.`,
    );
  }
  if (opts.endBeforeMs !== undefined && !Number.isFinite(opts.endBeforeMs)) {
    throw new Error("replaceItemSet endBeforeMs must be a finite number.");
  }
  if (opts.externalIdPrefix !== undefined && opts.externalIdPrefix === "") {
    throw new Error("replaceItemSet externalIdPrefix must not be empty.");
  }
}

/**
 * Deletes the rows of (`service`, `type`) that are CANDIDATES and whose `external_id` is not in
 * `keep`; returns the deleted count. The candidate set is every row of the pair, narrowed by
 * `opts.externalIdPrefix` and `opts.endBeforeMs` (both narrow; they never widen). The service is the
 * capability's closure, never a caller parameter. Each row goes through `deleteItemByPrimaryKey`,
 * the delete path of `deleteItem` (graph entities, then the row; FTS, embeddings and the V91
 * snapshot follow by trigger), inside ONE transaction: a failure leaves every row in place.
 * Metadata is parsed in JS with try/catch (`json_extract` raises on malformed JSON).
 */
export function replaceItemSetRows(
  db: Database,
  service: string,
  type: string,
  keep: readonly string[],
  opts: ReplaceItemSetOptions = {},
): number {
  validate(service, type, keep, opts);
  const keepSet = new Set(keep);
  const rows = db
    .query("SELECT id, external_id, metadata FROM item WHERE service = ? AND type = ?")
    .all(service, type) as CandidateRow[];
  const doomed = rows.filter((row) => {
    if (keepSet.has(row.external_id)) return false;
    if (opts.externalIdPrefix !== undefined && !row.external_id.startsWith(opts.externalIdPrefix)) {
      return false;
    }
    if (opts.endBeforeMs !== undefined) {
      const end = endMsOf(row.metadata);
      return end !== undefined && end < opts.endBeforeMs;
    }
    return true;
  });
  if (doomed.length === 0) return 0;
  db.transaction(() => {
    for (const row of doomed) deleteItemByPrimaryKey(db, row.id);
  })();
  return doomed.length;
}
