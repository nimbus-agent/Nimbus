/**
 * Pure mapping from a Raindrop `GET /rest/v1/raindrops/0` list element to the
 * {@link upsertIndexedItemForSync} row shape. Lives separately from
 * `raindrop-sync.ts` so the REST path and the indexing path can be tested
 * independently.
 *
 * Emits `service = "raindrop", type = "bookmark"` rows — a single item type.
 * `external_id = String(<bookmark _id>)`. The conceptual item identity is
 * `raindrop:bookmark`; the `item.id` ends up `raindrop:<id>`. A bookmark is
 * short (a URL plus an excerpt/note), so it stays on local MiniLM embeddings —
 * NOT added to `PROSE_HEAVY_TYPES` (avoids surprise OpenAI spend on the whole
 * bookmark corpus).
 *
 * IMPORTANT: Raindrop's `created` and `lastUpdate` are ISO-8601 STRINGS
 * (e.g. `"2024-03-01T12:00:00.000Z"`), like Readwise's / Mercury's timestamps
 * and UNLIKE the epoch-ms / epoch-seconds number APIs. Parse them to epoch-ms
 * with {@link parseIsoMs} — never pass the ISO string through verbatim, and
 * never treat it as epoch seconds.
 *
 * The `tags` array is a list of plain strings; the string array is stored
 * verbatim (filtering to strings, tolerating a non-array). The bookmarked
 * `link` is the canonical URL.
 */

import { asRecord, numberField, stringField } from "./unknown-record.ts";

export interface RaindropMappingContext {
  readonly syncedAt: number;
}

export interface RaindropMappedRow {
  readonly service: "raindrop";
  readonly type: "bookmark";
  readonly externalId: string;
  readonly title: string;
  readonly bodyPreview: string;
  readonly url: string | null;
  readonly canonicalUrl: string | null;
  readonly modifiedAt: number;
  readonly metadata: Record<string, unknown>;
  readonly syncedAt: number;
}

function parseIsoMs(v: unknown): number | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
}

/**
 * Tag strings from a Raindrop `tags: ["a", "b"]` array. Non-array input and
 * non-string entries are tolerated (skipped).
 */
export function tagStrings(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const names: string[] = [];
  for (const t of raw) {
    if (typeof t === "string") {
      names.push(t);
    }
  }
  return names;
}

export function mapRaindropBookmarkToItem(
  raw: unknown,
  ctx: RaindropMappingContext,
): RaindropMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

  // `_id` is a number — stringify for external_id; skip the row if missing.
  const idNum = numberField(row, "_id");
  if (idNum === undefined) {
    return null;
  }
  const id = String(idNum);

  const title = stringField(row, "title") ?? null;
  const link = stringField(row, "link") ?? null;
  const excerpt = stringField(row, "excerpt") ?? null;
  const note = stringField(row, "note") ?? null;
  const domain = stringField(row, "domain") ?? null;
  const type = stringField(row, "type") ?? null;
  const collectionId = numberField(row, "collectionId") ?? null;
  const tags = tagStrings(row["tags"]);

  const createdAt = parseIsoMs(row["created"]);
  const updatedAt = parseIsoMs(row["lastUpdate"]);

  // canonical/url: the bookmarked link when a non-empty string, else null.
  const canonicalUrl = link !== null && link !== "" ? link : null;

  // title: the bookmark title when present, else the link, else `Bookmark <id>`.
  const titleText =
    title !== null && title !== ""
      ? title
      : canonicalUrl !== null
        ? canonicalUrl
        : `Bookmark ${id}`;

  // bodyPreview: the excerpt when present, else the note, else the domain, else
  // the title.
  const bodyPreview =
    excerpt !== null && excerpt !== ""
      ? excerpt
      : note !== null && note !== ""
        ? note
        : domain !== null && domain !== ""
          ? domain
          : titleText;

  const modifiedAt = updatedAt ?? createdAt ?? ctx.syncedAt;

  const metadata: Record<string, unknown> = {
    bookmark_id: id,
    title,
    link: canonicalUrl,
    excerpt,
    note,
    domain,
    type,
    tags,
    collection_id: collectionId,
    created_at: createdAt,
    updated_at: updatedAt,
    canonical_url: canonicalUrl,
  };

  return {
    service: "raindrop",
    type: "bookmark",
    externalId: id,
    title: titleText,
    bodyPreview,
    url: canonicalUrl,
    canonicalUrl,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
