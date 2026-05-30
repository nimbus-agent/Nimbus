import { asObjectish, filterByQuery, type SearchMatchOptions } from "../../shared/search-filter.ts";

export type ReadwiseSearchMatchOptions = SearchMatchOptions;

function stringField(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : "";
}

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

export function filterReadwiseHighlights(
  highlights: readonly unknown[],
  options: ReadwiseSearchMatchOptions,
): unknown[] {
  return filterByQuery(highlights, { ...options, fields: fieldsOf });
}
