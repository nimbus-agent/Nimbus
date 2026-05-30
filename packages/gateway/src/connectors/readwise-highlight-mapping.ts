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
  const title =
    trimmedText === ""
      ? `Highlight ${id}`
      : trimmedText.length > TITLE_MAX
        ? `${trimmedText.slice(0, TITLE_MAX)}…`
        : trimmedText;

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
