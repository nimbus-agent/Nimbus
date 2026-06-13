import { asRecord, makeQueryFilter, type SearchMatchOptions } from "../../shared/search-filter.ts";

export type MonteCarloSearchMatchOptions = SearchMatchOptions;

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
    stringAt(row, "incidentId"),
    stringAt(row, "status"),
    stringAt(row, "severity"),
    stringAt(row, "monitoredTable"),
  ];
}

export const filterMonteCarloIncidents = makeQueryFilter(fieldsOf);
