import {
  asObjectish,
  makeQueryFilter,
  type SearchMatchOptions,
  stringField,
  tagText,
} from "../../shared/search-filter.ts";

export type LeverSearchMatchOptions = SearchMatchOptions;

function categoryField(row: Record<string, unknown>, key: string): string {
  const cats = row["categories"];
  if (cats === null || typeof cats !== "object" || Array.isArray(cats)) {
    return "";
  }
  const v = (cats as Record<string, unknown>)[key];
  return typeof v === "string" ? v : "";
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

export const filterLeverPostings = makeQueryFilter(fieldsOf);
