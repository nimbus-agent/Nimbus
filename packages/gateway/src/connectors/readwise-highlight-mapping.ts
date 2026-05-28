/**
 * Pure mapping from a Readwise `GET /api/v2/highlights/` list element to the
 * {@link upsertIndexedItemForSync} row shape. Lives separately from
 * `readwise-sync.ts` so the REST path and the indexing path can be tested
 * independently.
 *
 * Emits `service = "readwise", type = "highlight"` rows — a single item type.
 * `external_id = String(<highlight id>)`. The conceptual item identity is
 * `readwise:highlight`; the `item.id` ends up `readwise:<id>`. A highlight is
 * short (an excerpt plus a note), so it stays on local MiniLM embeddings — NOT
 * added to `PROSE_HEAVY_TYPES` (avoids surprise OpenAI spend on the whole
 * highlight corpus).
 *
 * IMPORTANT: Readwise's `highlighted_at` and `updated` are ISO-8601 STRINGS
 * (e.g. `"2024-03-01T12:00:00.000Z"`), like Netlify's / Mercury's timestamps
 * and UNLIKE the epoch-ms / epoch-seconds number APIs. Parse them to epoch-ms
 * with {@link parseIsoMs} — never pass the ISO string through verbatim, and
 * never treat it as epoch seconds.
 *
 * The `tags` array is a list of `{ id, name }` objects; only the tag NAMES are
 * stored (as a string array), tolerating non-object entries. The source article
 * `url` (present for web highlights, null for book highlights) is the canonical
 * URL — book highlights have no per-highlight public URL.
 */

import { asRecord, numberField, stringField } from "./unknown-record.ts";

export interface ReadwiseMappingContext {
  readonly syncedAt: number;
}

export interface ReadwiseMappedRow {
  readonly service: "readwise";
  readonly type: "highlight";
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

const TITLE_MAX = 80;

/**
 * Tag NAMES from a Readwise `tags: [{ id, name }]` array. Non-array input and
 * non-object / nameless entries are tolerated (skipped).
 */
export function tagNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const names: string[] = [];
  for (const t of raw) {
    const row = asRecord(t);
    if (row === undefined) {
      continue;
    }
    const name = stringField(row, "name");
    if (name !== undefined && name !== "") {
      names.push(name);
    }
  }
  return names;
}

export function mapReadwiseHighlightToItem(
  raw: unknown,
  ctx: ReadwiseMappingContext,
): ReadwiseMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

  // `id` is a number — stringify for external_id; skip the row if missing.
  const idNum = numberField(row, "id");
  if (idNum === undefined) {
    return null;
  }
  const id = String(idNum);

  const text = stringField(row, "text") ?? null;
  const note = stringField(row, "note") ?? null;
  const location = numberField(row, "location") ?? null;
  const locationType = stringField(row, "location_type") ?? null;
  const color = stringField(row, "color") ?? null;
  const bookId = numberField(row, "book_id") ?? null;
  // The source article URL is present for web highlights, null for books.
  const sourceUrl = stringField(row, "url") ?? null;
  const tags = tagNames(row["tags"]);

  const highlightedAt = parseIsoMs(row["highlighted_at"]);
  const updatedAt = parseIsoMs(row["updated"]);

  // title: the first 80 chars of the highlight text (trimmed; append `…` when
  // truncated); fall back to `Highlight <id>`.
  const trimmedText = text !== null ? text.trim() : "";
  const title =
    trimmedText !== ""
      ? trimmedText.length > TITLE_MAX
        ? `${trimmedText.slice(0, TITLE_MAX)}…`
        : trimmedText
      : `Highlight ${id}`;

  // bodyPreview: the user's note when present, else the highlight text.
  const bodyPreview = note !== null && note !== "" ? note : (text ?? "");

  // canonical/url: the source article URL when a non-empty string, else null.
  const canonicalUrl = sourceUrl !== null && sourceUrl !== "" ? sourceUrl : null;

  const modifiedAt = updatedAt ?? highlightedAt ?? ctx.syncedAt;

  const metadata: Record<string, unknown> = {
    highlight_id: id,
    text,
    note,
    book_id: bookId,
    location,
    location_type: locationType,
    color,
    tags,
    source_url: canonicalUrl,
    highlighted_at: highlightedAt,
    updated_at: updatedAt,
    canonical_url: canonicalUrl,
  };

  return {
    service: "readwise",
    type: "highlight",
    externalId: id,
    title,
    bodyPreview,
    url: canonicalUrl,
    canonicalUrl,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
