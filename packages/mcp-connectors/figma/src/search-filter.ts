import {
  asObjectish,
  makeQueryFilter,
  type SearchMatchOptions,
  stringField,
} from "../../shared/search-filter.ts";

export type FigmaSearchMatchOptions = SearchMatchOptions;

/**
 * Figma file objects are flat — `{ key, name, thumbnail_url, last_modified }`.
 * When flattened by the connector for search, each file additionally carries
 * a `project_name` label. Match against the file name and the project name
 * (case-insensitive substring).
 */
function fieldsOf(item: unknown): readonly string[] | null {
  const row = asObjectish(item);
  if (row === undefined) {
    return null;
  }
  return [stringField(row, "name"), stringField(row, "project_name")];
}

export const filterFigmaFiles = makeQueryFilter(fieldsOf);
