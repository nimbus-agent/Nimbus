import { asRecord, filterByQuery, type SearchMatchOptions } from "../../shared/search-filter.ts";

export type SupersetSearchMatchOptions = SearchMatchOptions;

function stringAt(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : "";
}

function fieldsOf(item: unknown): readonly string[] | null {
  const row = asRecord(item);
  if (row === undefined) {
    return null;
  }
  return [stringAt(row, "dashboard_title"), stringAt(row, "slug")];
}

export function filterSupersetDashboards(
  dashboards: readonly unknown[],
  options: SupersetSearchMatchOptions,
): unknown[] {
  return filterByQuery(dashboards, { ...options, fields: fieldsOf });
}
