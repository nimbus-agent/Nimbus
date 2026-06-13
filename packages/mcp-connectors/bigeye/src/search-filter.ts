import { asRecord, makeQueryFilter, type SearchMatchOptions } from "../../shared/search-filter.ts";

export type BigeyeSearchMatchOptions = SearchMatchOptions;

function stringAt(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : "";
}

function fieldsOf(item: unknown): readonly string[] | null {
  const row = asRecord(item);
  if (row === undefined) {
    return null;
  }
  return [stringAt(row, "summary"), stringAt(row, "title"), stringAt(row, "description")];
}

export const filterBigeyeIssues = makeQueryFilter(fieldsOf);
