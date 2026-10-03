import { namedTags } from "./_lib/field-helpers.ts";
import type { MappedRow } from "./mapped-row.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

export interface ReadwiseMappingContext {
  readonly syncedAt: number;
}

export type ReadwiseMappedRow = MappedRow<"readwise", "highlight">;

function parseIsoMs(v: unknown): number | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
}

const TITLE_MAX = 80;

/** Readwise tag objects (`{ id, name }`) carry their label in `name`. */
export function tagNames(raw: unknown): string[] {
  return namedTags(raw);
}

export function mapReadwiseHighlightToItem(
  raw: unknown,
  ctx: ReadwiseMappingContext,
): ReadwiseMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

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
  const sourceUrl = stringField(row, "url") ?? null;
  const tags = tagNames(row["tags"]);

  const highlightedAt = parseIsoMs(row["highlighted_at"]);
  const updatedAt = parseIsoMs(row["updated"]);

  const trimmedText = text === null ? "" : text.trim();
  let title: string;
  if (trimmedText === "") {
    title = `Highlight ${id}`;
  } else if (trimmedText.length > TITLE_MAX) {
    title = `${trimmedText.slice(0, TITLE_MAX)}…`;
  } else {
    title = trimmedText;
  }

  const bodyPreview = note !== null && note !== "" ? note : (text ?? "");

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
