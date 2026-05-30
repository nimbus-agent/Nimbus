import {
  asObjectish,
  filterByQuery,
  type SearchMatchOptions,
  stringField,
  tagText,
} from "../../shared/search-filter.ts";

export type RaindropSearchMatchOptions = SearchMatchOptions;

function fieldsOf(item: unknown): readonly string[] | null {
  const row = asObjectish(item);
  if (row === undefined) {
    return null;
  }
  return [
    stringField(row, "title"),
    stringField(row, "excerpt"),
    stringField(row, "note"),
    stringField(row, "domain"),
    stringField(row, "link"),
    stringField(row, "type"),
    tagText(row),
  ];
}

export function filterRaindropBookmarks(
  bookmarks: readonly unknown[],
  options: RaindropSearchMatchOptions,
): unknown[] {
  return filterByQuery(bookmarks, { ...options, fields: fieldsOf });
}
