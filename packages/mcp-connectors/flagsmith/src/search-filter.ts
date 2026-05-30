import { asObjectish, filterByQuery, type SearchMatchOptions } from "../../shared/search-filter.ts";

export type FlagsmithSearchMatchOptions = SearchMatchOptions;

function stringField(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : "";
}

function tagsString(row: Record<string, unknown>): string {
  const tags = row["tags"];
  if (!Array.isArray(tags)) {
    return "";
  }
  return tags
    .filter((t): t is string | number => typeof t === "string" || typeof t === "number")
    .map(String)
    .join(" ");
}

function fieldsOf(item: unknown): readonly string[] | null {
  const row = asObjectish(item);
  if (row === undefined) {
    return null;
  }
  return [stringField(row, "name"), stringField(row, "description"), tagsString(row)];
}

export function filterFlagsmithFeatures(
  features: readonly unknown[],
  options: FlagsmithSearchMatchOptions,
): unknown[] {
  return filterByQuery(features, { ...options, fields: fieldsOf });
}
