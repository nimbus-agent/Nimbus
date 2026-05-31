import type { MappedRow } from "./mapped-row.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

export interface RaindropMappingContext {
  readonly syncedAt: number;
}

export type RaindropMappedRow = MappedRow<"raindrop", "bookmark">;

function parseIsoMs(v: unknown): number | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
}

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

function deriveRaindropTitle(
  title: string | null,
  canonicalUrl: string | null,
  id: string,
): string {
  if (title !== null && title !== "") {
    return title;
  }
  if (canonicalUrl !== null) {
    return canonicalUrl;
  }
  return `Bookmark ${id}`;
}

function deriveRaindropBodyPreview(args: {
  excerpt: string | null;
  note: string | null;
  domain: string | null;
  titleText: string;
}): string {
  const { excerpt, note, domain, titleText } = args;
  if (excerpt !== null && excerpt !== "") {
    return excerpt;
  }
  if (note !== null && note !== "") {
    return note;
  }
  if (domain !== null && domain !== "") {
    return domain;
  }
  return titleText;
}

export function mapRaindropBookmarkToItem(
  raw: unknown,
  ctx: RaindropMappingContext,
): RaindropMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

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

  const canonicalUrl = link !== null && link !== "" ? link : null;

  const titleText = deriveRaindropTitle(title, canonicalUrl, id);

  const bodyPreview = deriveRaindropBodyPreview({ excerpt, note, domain, titleText });

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
