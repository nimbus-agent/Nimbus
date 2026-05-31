import {
  asObjectish,
  makeQueryFilter,
  type SearchMatchOptions,
  stringField,
} from "../../shared/search-filter.ts";

export type LaunchDarklySearchMatchOptions = SearchMatchOptions;

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

export const filterLaunchDarklyFlags = makeQueryFilter(fieldsOf);
