import type { MappedRow } from "./mapped-row.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

export interface MendeleyMappingContext {
  readonly syncedAt: number;
}

export type MendeleyMappedRow = MappedRow<"mendeley", "reference">;

const TITLE_MAX = 120;
const ABSTRACT_MAX = 500;

function parseIsoMs(v: unknown): number | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
}

function authorNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const names: string[] = [];
  for (const a of raw) {
    const row = asRecord(a);
    if (row === undefined) {
      continue;
    }
    const first = stringField(row, "first_name") ?? "";
    const last = stringField(row, "last_name") ?? "";
    const combined = [first, last].filter((p) => p !== "").join(" ");
    if (combined !== "") {
      names.push(combined);
    }
  }
  return names;
}

function keywordList(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((k): k is string => typeof k === "string" && k !== "")
    : [];
}

function firstWebsite(raw: unknown): string | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  for (const w of raw) {
    if (typeof w === "string" && w !== "") {
      return w;
    }
  }
  return null;
}

function deriveTitle(title: string | null, docType: string | null, id: string): string {
  const trimmed = title === null ? "" : title.trim();
  if (trimmed === "") {
    return docType !== null && docType !== "" ? `${docType} ${id}` : `Reference ${id}`;
  }
  if (trimmed.length > TITLE_MAX) {
    return `${trimmed.slice(0, TITLE_MAX)}…`;
  }
  return trimmed;
}

export function mapMendeleyDocumentToItem(
  raw: unknown,
  ctx: MendeleyMappingContext,
): MendeleyMappedRow | null {
  const doc = asRecord(raw);
  if (doc === undefined) {
    return null;
  }

  const id = stringField(doc, "id");
  if (id === undefined || id === "") {
    return null;
  }

  const docType = stringField(doc, "type") ?? null;
  const rawTitle = stringField(doc, "title") ?? null;
  const year = numberField(doc, "year") ?? null;
  const source = stringField(doc, "source") ?? null;
  const abstractRaw = stringField(doc, "abstract") ?? null;
  const ids = asRecord(doc["identifiers"]);
  const doi = ids === undefined ? null : (stringField(ids, "doi") ?? null);
  const creators = authorNames(doc["authors"]);
  const keywords = keywordList(doc["keywords"]);
  const url = firstWebsite(doc["websites"]);

  const lastModified = parseIsoMs(doc["last_modified"]);
  const created = parseIsoMs(doc["created"]);

  const title = deriveTitle(rawTitle, docType, id);
  const abstract =
    abstractRaw !== null && abstractRaw.length > ABSTRACT_MAX
      ? `${abstractRaw.slice(0, ABSTRACT_MAX)}…`
      : abstractRaw;

  const creatorsOrTitle = creators.length > 0 ? creators.join(", ") : title;
  const bodyPreview = abstract !== null && abstract !== "" ? abstract : creatorsOrTitle;
  const canonicalUrl = url;
  const modifiedAt = lastModified ?? created ?? ctx.syncedAt;

  const metadata: Record<string, unknown> = {
    id,
    doc_type: docType,
    title: rawTitle,
    creators,
    year,
    source,
    last_modified: lastModified,
    created,
    keywords,
    doi,
    url: canonicalUrl,
    abstract,
  };

  return {
    service: "mendeley",
    type: "reference",
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
