/**
 * Pure mapping from a Raindrop.io **collection** to an `IndexedItem`-shaped
 * row. Sibling of `raindrop-bookmark-mapping.ts`: a bookmark carries a
 * `collection_id` with nothing to resolve it against until these rows exist.
 *
 * Collections come from TWO endpoints — `GET /rest/v1/collections` (root) and
 * `GET /rest/v1/collections/childrens` (every nested collection). Neither is
 * paginated; both return the `{ result, items: [...] }` envelope. The only
 * shape difference is that a child carries `parent.$id`. One mapper covers both.
 *
 * `external_id` is `collection/<numeric _id>`, NOT the bare numeric id.
 * Raindrop numbers collections and raindrops (bookmarks) in separate id spaces,
 * so collection 9001 and bookmark 9001 both exist; the item primary key is
 * `<service>:<external_id>` and `upsertIndexedItem` writes
 * `ON CONFLICT(id) DO UPDATE`, so a bare id would let each sync silently
 * overwrite the other type's row. Bookmarks keep their existing bare-id
 * `external_id` — re-prefixing them would orphan every already-indexed
 * bookmark row.
 *
 * `raindrop:collection` deliberately stays OFF `PROSE_HEAVY_TYPES` (local
 * MiniLM 384-dim), matching `raindrop:bookmark`: a collection is a name plus
 * counts — the Raindrop Collection object has no description field at all —
 * so there is no prose to embed, and adding it would send every hybrid-mode
 * user's collection tree through OpenAI on the next embed pass.
 */

import type { MappedRow } from "./mapped-row.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

export interface RaindropCollectionMappingContext {
  readonly syncedAt: number;
}

export type RaindropCollectionMappedRow = MappedRow<"raindrop", "collection">;

/** Namespace prefix that keeps `raindrop:collection/<id>` distinct from `raindrop:<bookmarkId>`. */
export const RAINDROP_COLLECTION_EXTERNAL_ID_PREFIX = "collection/";

function parseIsoMs(v: unknown): number | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
}

function boolOrNull(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

/** `parent: { $id: <number> }` → the id; null for a root collection or a malformed parent. */
export function parentCollectionId(raw: unknown): number | null {
  const parent = asRecord(raw);
  if (parent === undefined) {
    return null;
  }
  return numberField(parent, "$id") ?? null;
}

export function mapRaindropCollectionToItem(
  raw: unknown,
  ctx: RaindropCollectionMappingContext,
): RaindropCollectionMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

  const idNum = numberField(row, "_id");
  if (idNum === undefined) {
    return null;
  }
  const id = String(idNum);

  const rawTitle = stringField(row, "title")?.trim() ?? "";
  const title = rawTitle === "" ? null : rawTitle;
  const view = stringField(row, "view") ?? null;
  const color = stringField(row, "color") ?? null;
  const count = numberField(row, "count") ?? null;
  const sort = numberField(row, "sort") ?? null;
  const isPublic = boolOrNull(row["public"]);
  const parentId = parentCollectionId(row["parent"]);

  const createdAt = parseIsoMs(row["created"]);
  const updatedAt = parseIsoMs(row["lastUpdate"]);

  const titleText = title ?? `Collection ${id}`;

  const modifiedAt = updatedAt ?? createdAt ?? ctx.syncedAt;

  const metadata: Record<string, unknown> = {
    // NUMBER, not the stringified id: `raindrop:bookmark` stores its parent as
    // `metadata.collection_id` (a number), and this is the field that joins them.
    collection_id: idNum,
    title,
    count,
    public: isPublic,
    view,
    color,
    sort,
    parent_id: parentId,
    created_at: createdAt,
    updated_at: updatedAt,
    // The API returns no URL for a collection; constructing an app deep link
    // would be inventing data the vendor did not send.
    canonical_url: null,
  };

  return {
    service: "raindrop",
    type: "collection",
    externalId: `${RAINDROP_COLLECTION_EXTERNAL_ID_PREFIX}${id}`,
    title: titleText,
    // The Raindrop Collection object has no description field — the title is
    // the only free text there is.
    bodyPreview: titleText,
    url: null,
    canonicalUrl: null,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
