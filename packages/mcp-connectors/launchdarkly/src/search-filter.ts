import { asObjectish, filterByQuery, type SearchMatchOptions } from "../../shared/search-filter.ts";

export type LaunchDarklySearchMatchOptions = SearchMatchOptions;

function stringField(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : "";
}

function tagsString(row: Record<string, unknown>): string {
  const tags = row["tags"];
  if (!Array.isArray(tags)) {
    return "";
  }
  return tags.filter((t): t is string => typeof t === "string").join(" ");
}

function fieldsOf(item: unknown): readonly string[] | null {
  const row = asObjectish(item);
  if (row === undefined) {
    return null;
  }
  return [
    stringField(row, "key"),
    stringField(row, "name"),
    stringField(row, "description"),
    tagsString(row),
  ];
}

export function filterLaunchDarklyFlags(
  flags: readonly unknown[],
  options: LaunchDarklySearchMatchOptions,
): unknown[] {
  return filterByQuery(flags, { ...options, fields: fieldsOf });
}
