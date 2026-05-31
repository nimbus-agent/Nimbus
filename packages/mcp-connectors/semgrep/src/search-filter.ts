import {
  asObjectish,
  makeQueryFilter,
  type SearchMatchOptions,
  stringField,
} from "../../shared/search-filter.ts";

export type SemgrepSearchMatchOptions = SearchMatchOptions;

function nestedString(row: Record<string, unknown>, parent: string, key: string): string {
  const p = row[parent];
  if (p === null || typeof p !== "object") {
    return "";
  }
  return stringField(p as Record<string, unknown>, key);
}

function fieldsOf(item: unknown): readonly string[] | null {
  const row = asObjectish(item);
  if (row === undefined) {
    return null;
  }
  return [
    stringField(row, "rule_name"),
    stringField(row, "rule_message"),
    nestedString(row, "location", "file_path"),
    nestedString(row, "repository", "name"),
  ];
}

export const filterSemgrepFindings = makeQueryFilter(fieldsOf);
