import { asRecord, makeQueryFilter, type SearchMatchOptions } from "../../shared/search-filter.ts";

export type SnowflakeSearchMatchOptions = SearchMatchOptions;

function stringAt(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : "";
}

function fieldsOf(item: unknown): readonly string[] | null {
  const row = asRecord(item);
  if (row === undefined) {
    return null;
  }
  return [
    stringAt(row, "table_name"),
    stringAt(row, "schema_name"),
    stringAt(row, "database_name"),
  ];
}

export const filterSnowflakeTables = makeQueryFilter(fieldsOf);
