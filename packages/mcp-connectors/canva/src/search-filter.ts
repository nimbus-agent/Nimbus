import {
  asObjectish,
  makeQueryFilter,
  type SearchMatchOptions,
  stringField,
} from "../../shared/search-filter.ts";

export type CanvaSearchMatchOptions = SearchMatchOptions;

/**
 * Canva design objects are flat — `{ id, title, urls: { edit_url, view_url },
 * thumbnail: { url, ... }, ... }`. Designs carry no description or owner field,
 * so match against the design title (case-insensitive substring).
 */
function fieldsOf(item: unknown): readonly string[] | null {
  const row = asObjectish(item);
  if (row === undefined) {
    return null;
  }
  return [stringField(row, "title")];
}

export const filterCanvaDesigns = makeQueryFilter(fieldsOf);
