import { asObjectish, filterByQuery, type SearchMatchOptions } from "../../shared/search-filter.ts";

export type PipedriveSearchMatchOptions = SearchMatchOptions;

function stringField(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : "";
}

function fieldsOf(item: unknown): readonly string[] | null {
  const row = asObjectish(item);
  if (row === undefined) {
    return null;
  }
  return [
    stringField(row, "title"),
    stringField(row, "status"),
    stringField(row, "org_name"),
    stringField(row, "person_name"),
    stringField(row, "owner_name"),
    stringField(row, "label"),
  ];
}

export function filterPipedriveDeals(
  deals: readonly unknown[],
  options: PipedriveSearchMatchOptions,
): unknown[] {
  return filterByQuery(deals, { ...options, fields: fieldsOf });
}
