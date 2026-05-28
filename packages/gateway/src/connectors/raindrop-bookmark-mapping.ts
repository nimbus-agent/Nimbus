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

  const titleText =
    title !== null && title !== ""
      ? title
      : canonicalUrl !== null
        ? canonicalUrl
        : `Bookmark ${id}`;

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
