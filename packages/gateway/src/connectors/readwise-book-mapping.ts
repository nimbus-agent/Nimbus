/**
 * Pure mapping from a Readwise **book** (`GET /api/v2/books/`) to an
 * `IndexedItem`-shaped row. Sibling of `readwise-highlight-mapping.ts`: a
 * highlight carries a `book_id` with nothing to resolve it against until these
 * rows exist.
 *
 * `external_id` is `book/<numeric id>`, NOT the bare numeric id. Readwise
 * numbers books and highlights in separate sequences, so book 9001 and
 * highlight 9001 both exist; the item primary key is `<service>:<external_id>`
 * and `upsertIndexedItem` writes `ON CONFLICT(id) DO UPDATE`, so a bare id
 * would let each sync silently overwrite the other type's row. Highlights keep
 * their existing bare-id `external_id` — re-prefixing them would orphan every
 * already-indexed highlight row.
 *
 * `readwise:book` deliberately stays OFF `PROSE_HEAVY_TYPES` (local MiniLM
 * 384-dim), matching `readwise:highlight`: a book record is a title, an author
 * and a short user note, not paragraph-shaped prose, and adding it would send
 * every hybrid-mode user's whole library through OpenAI on the next embed pass.
 */

import type { MappedRow } from "./mapped-row.ts";
import { tagNames } from "./readwise-highlight-mapping.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

export interface ReadwiseBookMappingContext {
  readonly syncedAt: number;
}

export type ReadwiseBookMappedRow = MappedRow<"readwise", "book">;

/** Namespace prefix that keeps `readwise:book/<id>` distinct from `readwise:<highlightId>`. */
export const READWISE_BOOK_EXTERNAL_ID_PREFIX = "book/";

function parseIsoMs(v: unknown): number | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
}

/** Trimmed string field, or null when absent/blank. */
function trimmedField(row: Record<string, unknown>, key: string): string | null {
  const raw = stringField(row, key);
  if (raw === undefined) {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

function firstNonNull(candidates: readonly (string | null)[], fallback: string): string {
  for (const candidate of candidates) {
    if (candidate !== null) {
      return candidate;
    }
  }
  return fallback;
}

export function mapReadwiseBookToItem(
  raw: unknown,
  ctx: ReadwiseBookMappingContext,
): ReadwiseBookMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

  const idNum = numberField(row, "id");
  if (idNum === undefined) {
    return null;
  }
  const id = String(idNum);

  const title = trimmedField(row, "title");
  const author = trimmedField(row, "author");
  const category = trimmedField(row, "category");
  const source = trimmedField(row, "source");
  const documentNote = trimmedField(row, "document_note");
  const asin = trimmedField(row, "asin");
  const sourceUrl = trimmedField(row, "source_url");
  const highlightsUrl = trimmedField(row, "highlights_url");
  const numHighlights = numberField(row, "num_highlights") ?? null;
  const tags = tagNames(row["tags"]);

  const lastHighlightAt = parseIsoMs(row["last_highlight_at"]);
  const updatedAt = parseIsoMs(row["updated"]);

  const titleText = firstNonNull([title, author], `Book ${id}`);
  const bodyPreview = firstNonNull([documentNote, author, category], titleText);

  // Kindle/ePub books have no public source URL; the Readwise book-review page
  // is the only stable, user-openable URL for them.
  const canonicalUrl = sourceUrl ?? highlightsUrl;

  const modifiedAt = updatedAt ?? lastHighlightAt ?? ctx.syncedAt;

  const metadata: Record<string, unknown> = {
    // NUMBER, not the stringified id: `readwise:highlight` stores its parent as
    // `metadata.book_id` (a number), and this is the field that joins them.
    book_id: idNum,
    title,
    author,
    category,
    source,
    num_highlights: numHighlights,
    asin,
    tags,
    document_note: documentNote,
    source_url: sourceUrl,
    highlights_url: highlightsUrl,
    last_highlight_at: lastHighlightAt,
    updated_at: updatedAt,
    canonical_url: canonicalUrl,
  };

  return {
    service: "readwise",
    type: "book",
    externalId: `${READWISE_BOOK_EXTERNAL_ID_PREFIX}${id}`,
    title: titleText,
    bodyPreview,
    url: canonicalUrl,
    canonicalUrl,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
