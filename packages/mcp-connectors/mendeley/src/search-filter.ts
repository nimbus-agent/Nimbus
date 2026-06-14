import {
  asObjectish,
  makeQueryFilter,
  type SearchMatchOptions,
  stringField,
} from "../../shared/search-filter.ts";

export type MendeleySearchMatchOptions = SearchMatchOptions;

function nonEmptyString(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function authorName(a: unknown): string | null {
  if (a === null || typeof a !== "object") {
    return null;
  }
  const row = a as Record<string, unknown>;
  const parts = [nonEmptyString(row["first_name"]), nonEmptyString(row["last_name"])].filter(
    (p): p is string => p !== null,
  );
  return parts.length > 0 ? parts.join(" ") : null;
}

function authorNames(doc: Record<string, unknown>): string {
  const authors = doc["authors"];
  if (!Array.isArray(authors)) {
    return "";
  }
  const names: string[] = [];
  for (const a of authors) {
    const name = authorName(a);
    if (name !== null) {
      names.push(name);
    }
  }
  return names.join(" ");
}

function keywordNames(doc: Record<string, unknown>): string {
  const keywords = doc["keywords"];
  return Array.isArray(keywords)
    ? keywords.filter((k): k is string => typeof k === "string").join(" ")
    : "";
}

function doi(doc: Record<string, unknown>): string {
  const ids = asObjectish(doc["identifiers"]);
  return ids === undefined ? "" : stringField(ids, "doi");
}

function fieldsOf(item: unknown): readonly string[] | null {
  const doc = asObjectish(item);
  if (doc === undefined) {
    return null;
  }
  return [
    stringField(doc, "title"),
    stringField(doc, "type"),
    stringField(doc, "abstract"),
    stringField(doc, "source"),
    doi(doc),
    authorNames(doc),
    keywordNames(doc),
  ];
}

export const filterMendeleyDocuments = makeQueryFilter(fieldsOf);
