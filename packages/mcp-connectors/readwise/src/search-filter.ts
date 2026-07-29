import {
  asObjectish,
  makeQueryFilter,
  type SearchMatchOptions,
  stringField,
} from "../../shared/search-filter.ts";

export type ReadwiseSearchMatchOptions = SearchMatchOptions;

function tagNames(row: Record<string, unknown>): string {
  const tags = row["tags"];
  if (!Array.isArray(tags)) {
    return "";
  }
  const names: string[] = [];
  for (const t of tags) {
    if (t !== null && typeof t === "object") {
      const name = (t as Record<string, unknown>)["name"];
      if (typeof name === "string") {
        names.push(name);
      }
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
    stringField(row, "note"),
    stringField(row, "color"),
    stringField(row, "location_type"),
    tagNames(row),
  ];
}

export const filterReadwiseHighlights = makeQueryFilter(fieldsOf);

/**
 * Book haystack: title, author, category, source, the user's document note, and
 * tag names. `cover_image_url` / `highlights_url` / `source_url` are deliberately
 * excluded — matching a URL substring is noise, and the highlight filter makes
 * the same choice for its `url`.
 */
function bookFieldsOf(item: unknown): readonly string[] | null {
  const row = asObjectish(item);
  if (row === undefined) {
    return null;
  }
  return [
    stringField(row, "title"),
    stringField(row, "author"),
    stringField(row, "category"),
    stringField(row, "source"),
    stringField(row, "document_note"),
    tagNames(row),
  ];
}

export const filterReadwiseBooks = makeQueryFilter(bookFieldsOf);
