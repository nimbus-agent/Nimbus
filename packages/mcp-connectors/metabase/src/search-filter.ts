import { asRecord, filterByQuery, type SearchMatchOptions } from "../../shared/search-filter.ts";

export type MetabaseSearchMatchOptions = SearchMatchOptions;

function stringAt(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : "";
}

function fieldsOf(item: unknown): readonly string[] | null {
  const row = asRecord(item);
  if (row === undefined) {
    return null;
  }
  return [stringAt(row, "name"), stringAt(row, "description")];
}

export function filterMetabaseDashboards(
  dashboards: readonly unknown[],
  options: MetabaseSearchMatchOptions,
): unknown[] {
  return filterByQuery(dashboards, { ...options, fields: fieldsOf });
}
