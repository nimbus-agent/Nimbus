import type { MappedRow } from "./mapped-row.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

export interface ZoteroMappingContext {
  readonly syncedAt: number;
}

export type ZoteroMappedRow = MappedRow<"zotero", "reference">;

const SKIP_ITEM_TYPES: ReadonlySet<string> = new Set(["attachment", "note"]);

const TITLE_MAX = 120;
const ABSTRACT_MAX = 500;

function parseIsoMs(v: unknown): number | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
}

export function creatorNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const names: string[] = [];
  for (const c of raw) {
    const row = asRecord(c);
    if (row === undefined) {
      continue;
    }
    const single = stringField(row, "name");
    if (single !== undefined && single !== "") {
      names.push(single);
      continue;
    }
    const first = stringField(row, "firstName") ?? "";
    const last = stringField(row, "lastName") ?? "";
    const combined = [first, last].filter((p) => p !== "").join(" ");
    if (combined !== "") {
      names.push(combined);
    }
  }
  return names;
}

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
    const tag = stringField(row, "tag");
    if (tag !== undefined && tag !== "") {
      names.push(tag);
    }
  }
  return names;
}

function collectionKeys(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const keys: string[] = [];
  for (const c of raw) {
    if (typeof c === "string" && c !== "") {
      keys.push(c);
    }
  }
  return keys;
}

function deriveTitle(title: string | null, itemType: string | null, id: string): string {
  const trimmed = title === null ? "" : title.trim();
  if (trimmed === "") {
    return itemType !== null && itemType !== "" ? `${itemType} ${id}` : `Reference ${id}`;
  }
  if (trimmed.length > TITLE_MAX) {
    return `${trimmed.slice(0, TITLE_MAX)}…`;
  }
  return trimmed;
}

export function mapZoteroReferenceToItem(
  raw: unknown,
  ctx: ZoteroMappingContext,
): ZoteroMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

  const key = stringField(row, "key");
  if (key === undefined || key === "") {
    return null;
  }

  const data = asRecord(row["data"]);
  if (data === undefined) {
    return null;
  }

  const itemType = stringField(data, "itemType") ?? null;
  if (itemType !== null && SKIP_ITEM_TYPES.has(itemType)) {
    return null;
  }

  const version = numberField(row, "version") ?? null;
  const rawTitle = stringField(data, "title") ?? null;
  const date = stringField(data, "date") ?? null;
  const url = stringField(data, "url") ?? null;
  const doi = stringField(data, "DOI") ?? null;
  const abstractRaw = stringField(data, "abstractNote") ?? null;
  const publicationTitle = stringField(data, "publicationTitle") ?? null;
  const creators = creatorNames(data["creators"]);
  const tags = tagNames(data["tags"]);
  const collections = collectionKeys(data["collections"]);

  const dateModified = parseIsoMs(data["dateModified"]);
  const dateAdded = parseIsoMs(data["dateAdded"]);

  const title = deriveTitle(rawTitle, itemType, key);

  const abstract =
    abstractRaw !== null && abstractRaw.length > ABSTRACT_MAX
      ? `${abstractRaw.slice(0, ABSTRACT_MAX)}…`
      : abstractRaw;

  const bodyPreview =
    abstract !== null && abstract !== ""
      ? abstract
      : creators.length > 0
        ? creators.join(", ")
        : title;

  const canonicalUrl = url !== null && url !== "" ? url : null;

  const modifiedAt = dateModified ?? dateAdded ?? ctx.syncedAt;

  const metadata: Record<string, unknown> = {
    key,
    version,
    item_type: itemType,
    title: rawTitle,
    creators,
    date,
    date_modified: dateModified,
    date_added: dateAdded,
    tags,
    collections,
    doi,
    url: canonicalUrl,
    abstract,
    publication_title: publicationTitle,
  };

  return {
    service: "zotero",
    type: "reference",
    externalId: key,
    title,
    bodyPreview,
    url: canonicalUrl,
    canonicalUrl,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
