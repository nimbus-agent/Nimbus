import type { Database } from "bun:sqlite";
import type { NimbusItem } from "@nimbus-dev/sdk";

import { dbRun } from "../db/write.ts";
import { type ResolveServiceId, syncGraphFromIndexedItem } from "../graph/graph-populator.ts";
import { deleteGraphEntitiesForItemKeys } from "../graph/relationship-graph.ts";
import type { SyncContext } from "../sync/types.ts";
import { BODY_MAX_DEFAULT, BODY_PREVIEW_MAX, bodyCapForItemType, clampBody } from "./body-caps.ts";
import { RAW_META_MAX_BYTES } from "./constants.ts";
import { itemPrimaryKey } from "./item-key.ts";

export { itemPrimaryKey } from "./item-key.ts";

export type IndexedItemRow = {
  id: string;
  service: string;
  type: string;
  external_id: string;
  title: string;
  body: string | null;
  body_preview: string | null;
  body_complete: number;
  url: string | null;
  canonical_url: string | null;
  modified_at: number;
  author_id: string | null;
  metadata: string | null;
  synced_at: number;
  pinned: number;
};

export function itemExternalIdFromInput(service: string, idOrExternal: string): string {
  const prefix = `${service}:`;
  if (idOrExternal.startsWith(prefix)) {
    return idOrExternal.slice(prefix.length);
  }
  return idOrExternal;
}

/**
 * A caller supplies EITHER a legacy `bodyPreview` (clamped to 512, never
 * claims completeness) OR a declared-full `body` (clamped to the type's cap).
 * Supplying both is a type error: they would be two sources of truth for one
 * column pair.
 *
 * Do NOT relax this to `{ bodyPreview?: string; body?: string }` with a runtime
 * check. The union was probed under `tsc --strict` against every real call
 * shape — plain literal, object spread, the `{ ...row, url }` re-spread in
 * `upsertNimbusItemIntoItemTable`, the `Parameters<typeof upsertIndexedItem>[1]`
 * wrapper, and a `string | undefined` value — and all compile clean, while
 * supplying both fields fails with TS2345. Relaxing it would trade a
 * compile-time guarantee for a runtime one and gain nothing.
 *
 * `bodyTruncated` rides the `body` arm only. It lets a connector say "I
 * fetched a body, and I know it is not all of it" — the one thing the
 * length-vs-cap test cannot express, because such a body is usually well
 * under the cap. It is deliberately unavailable on the `bodyPreview` arm,
 * which never claims completeness in the first place.
 */
export type IndexedItemBodyInput =
  | { bodyPreview?: string; body?: undefined; bodyTruncated?: undefined }
  | { body: string; bodyPreview?: undefined; bodyTruncated?: boolean };

export function upsertIndexedItem(
  db: Database,
  row: {
    service: string;
    type: string;
    externalId: string;
    title: string;
    url?: string | null;
    canonicalUrl?: string | null;
    modifiedAt: number;
    authorId?: string | null;
    metadata?: Record<string, unknown>;
    pinned?: boolean;
    syncedAt: number;
  } & IndexedItemBodyInput,
  resolveServiceId?: ResolveServiceId,
): void {
  const id = itemPrimaryKey(row.service, row.externalId);
  const meta = JSON.stringify(row.metadata ?? {});
  if (Buffer.byteLength(meta, "utf8") > RAW_META_MAX_BYTES) {
    throw new Error(`metadata for item "${id}" exceeds 64 KB limit`);
  }
  const declaredFull = row.body !== undefined;
  const cap = declaredFull ? bodyCapForItemType(row.service, row.type) : BODY_MAX_DEFAULT;
  const raw = row.body ?? row.bodyPreview ?? row.title;
  const body = clampBody(raw, cap);
  const preview = clampBody(body, BODY_PREVIEW_MAX);
  const bodyComplete = declaredFull && raw.length <= cap && row.bodyTruncated !== true ? 1 : 0;
  dbRun(
    db,
    `INSERT INTO item (
      id, service, type, external_id, title, body, body_preview, body_complete,
      url, canonical_url, modified_at, author_id, metadata, synced_at, pinned
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      service = excluded.service,
      type = excluded.type,
      external_id = excluded.external_id,
      title = excluded.title,
      body = excluded.body,
      body_preview = excluded.body_preview,
      body_complete = excluded.body_complete,
      url = excluded.url,
      canonical_url = excluded.canonical_url,
      modified_at = excluded.modified_at,
      author_id = excluded.author_id,
      metadata = excluded.metadata,
      synced_at = excluded.synced_at,
      pinned = excluded.pinned`,
    [
      id,
      row.service,
      row.type,
      row.externalId,
      row.title,
      body,
      preview,
      bodyComplete,
      row.url ?? null,
      row.canonicalUrl ?? null,
      row.modifiedAt,
      row.authorId ?? null,
      meta,
      row.syncedAt,
      row.pinned === true ? 1 : 0,
    ],
  );
  syncGraphFromIndexedItem(
    db,
    {
      id,
      service: row.service,
      type: row.type,
      title: row.title,
      // Deliberately the 512-char preview, not `body`. Widening the graph
      // populator's input is a separate change with its own measurement.
      bodyPreview: preview,
      authorId: row.authorId ?? null,
      metadata: row.metadata ?? {},
    },
    resolveServiceId,
  );
}

type BodyRow = Parameters<typeof upsertIndexedItem>[1];

/**
 * Coerce a connector's body input to the connector's configured depth.
 *
 * `metadata_only` passes `body: ""` rather than omitting the input, because
 * `upsertIndexedItem` computes `raw = row.body ?? row.bodyPreview ?? row.title`
 * — omission would fall through to the TITLE and store it as the body. The
 * empty string is not nullish, so it wins that chain and both `body` and
 * `body_preview` land empty. `bodyTruncated` keeps `body_complete` at 0 so a
 * suppressed body is never reported as a complete one.
 */
function applyDepth(depth: SyncContext["depth"], row: BodyRow): BodyRow {
  // Suppression is OPT-IN: only the two depths that actually mean "hold text
  // back" touch the row; anything else — including a depth that somehow
  // arrives undefined — passes through unchanged. `SyncContext["depth"]` is
  // required and the scheduler always supplies it, so this is unreachable in
  // production, but the direction matters: routing an unknown depth into the
  // `summary` arm would clamp to 512 characters, which is the opposite of
  // `sync/scheduler.ts` `getDepthForService()`, `connectors/health.ts`'s
  // `sync_state` insert and the V49 backfill, all of which resolve an
  // unspecified depth to `full`. One direction for one unknown input.
  if (depth !== "metadata_only" && depth !== "summary") {
    return row;
  }
  const { body, bodyPreview, bodyTruncated, ...rest } = row as BodyRow & {
    body?: string;
    bodyPreview?: string;
    bodyTruncated?: boolean;
  };
  if (depth === "metadata_only") {
    return { ...rest, body: "", bodyTruncated: true } as BodyRow;
  }
  // summary: force the legacy preview arm, which clamps to 512 and never
  // claims completeness.
  const text = body ?? bodyPreview ?? "";
  return { ...rest, bodyPreview: text } as BodyRow;
}

export function upsertIndexedItemForSync(ctx: SyncContext, row: BodyRow): void {
  upsertIndexedItem(ctx.db, applyDepth(ctx.depth, row), ctx.resolveServiceId);
  const id = itemPrimaryKey(row.service, row.externalId);
  ctx.scheduleItemEmbedding?.(id);
}

export function upsertNimbusItemIntoItemTable(
  db: Database,
  item: NimbusItem,
  syncedAt: number,
): void {
  const externalId = itemExternalIdFromInput(item.service, item.id);
  const meta: Record<string, unknown> = item.rawMeta === undefined ? {} : { ...item.rawMeta };
  if (item.mimeType !== undefined) {
    meta["mime_type"] = item.mimeType;
  }
  if (item.sizeBytes !== undefined) {
    meta["size_bytes"] = item.sizeBytes;
  }
  if (item.parentId !== undefined) {
    meta["parent_id"] = item.parentId;
  }
  if (item.createdAt !== undefined) {
    meta["created_at"] = item.createdAt;
  }
  const row = {
    service: item.service,
    type: item.itemType,
    externalId,
    title: item.name,
    bodyPreview: item.name,
    modifiedAt: item.modifiedAt ?? item.createdAt ?? 0,
    metadata: meta,
    syncedAt,
  };
  if (item.url === undefined) {
    upsertIndexedItem(db, row);
  } else {
    upsertIndexedItem(db, { ...row, url: item.url });
  }
}

export function deleteItemByPrimaryKey(db: Database, primaryKey: string): void {
  const row = db.query("SELECT id FROM item WHERE id = ?").get(primaryKey) as
    | { id: string }
    | null
    | undefined;
  if (row?.id !== undefined) {
    deleteGraphEntitiesForItemKeys(db, [row.id]);
  }
  dbRun(db, "DELETE FROM item WHERE id = ?", [primaryKey]);
}

export function deleteItemByServiceExternal(
  db: Database,
  service: string,
  externalId: string,
): void {
  deleteItemByPrimaryKey(db, itemPrimaryKey(service, externalId));
}

export function deleteAllItemsForService(db: Database, service: string): void {
  const keys = db.query("SELECT id FROM item WHERE service = ?").all(service) as { id: string }[];
  if (keys.length > 0) {
    deleteGraphEntitiesForItemKeys(
      db,
      keys.map((k) => k.id),
    );
  }
  dbRun(db, "DELETE FROM item WHERE service = ?", [service]);
}

export type ItemBodyFetchState = { modifiedAt: number; bodyFetch: string | null };

/**
 * The two facts a connector needs to decide whether re-fetching an item's body
 * could gain anything: when we last saw it change, and the verdict the
 * connector recorded last time it tried. A `bodyFetch` of `"complete"` or
 * `"capped"` both mean "do not re-fetch"; `null` means never attempted, or
 * attempted and errored — which marks the item retryable in principle, but
 * does not by itself guarantee a retry happens. A sync that folds this item's
 * timestamp into its watermark before attempting the body fetch (Notion:
 * see the errored branch in `connectors/notion-sync.ts`) will normally have
 * already advanced past it by the time the fetch fails, so the item is
 * re-examined only on a later edit or an explicit `nimbus index rebody`.
 */
export function selectItemBodyFetchState(db: Database, id: string): ItemBodyFetchState | null {
  const row = db
    .query<{ modified_at: number; body_fetch: string | null }, [string]>(
      `SELECT modified_at, json_extract(metadata, '$.bodyFetch') AS body_fetch
         FROM item WHERE id = ?`,
    )
    .get(id);
  return row === null ? null : { modifiedAt: row.modified_at, bodyFetch: row.body_fetch };
}
