import { asObjectish, filterByQuery, type SearchMatchOptions } from "../../shared/search-filter.ts";

export type LeverSearchMatchOptions = SearchMatchOptions;

function stringField(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : "";
}

function categoryField(row: Record<string, unknown>, key: string): string {
  const cats = row["categories"];
  if (cats === null || typeof cats !== "object" || Array.isArray(cats)) {
    return "";
  }
  const v = (cats as Record<string, unknown>)[key];
  return typeof v === "string" ? v : "";
}

function tagText(row: Record<string, unknown>): string {
  const tags = row["tags"];
  if (!Array.isArray(tags)) {
    return "";
  }
  const names: string[] = [];
  for (const t of tags) {
    if (typeof t === "string") {
      names.push(t);
    }
  }
  return names.join(" ");
}

function fieldsOf(item: unknown): readonly string[] | null {
  const row = asObjectish(item);
  if (row === undefined) {
    return null;
  }
  return [
    stringField(row, "text"),
    stringField(row, "state"),
    categoryField(row, "team"),
    categoryField(row, "department"),
    categoryField(row, "location"),
    tagText(row),
  ];
}

export function filterLeverPostings(
  postings: readonly unknown[],
  options: LeverSearchMatchOptions,
): unknown[] {
  return filterByQuery(postings, { ...options, fields: fieldsOf });
}
