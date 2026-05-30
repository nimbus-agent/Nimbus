import { asRecord, filterByQuery, type SearchMatchOptions } from "../../shared/search-filter.ts";

export type DatabricksSearchMatchOptions = SearchMatchOptions;

function stringAt(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : "";
}

function numberAt(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === "number" && Number.isFinite(v) ? String(v) : "";
}

function fieldsOf(item: unknown): readonly string[] | null {
  const row = asRecord(item);
  if (row === undefined) {
    return null;
  }
  const settings = asRecord(row["settings"]) ?? {};
  return [stringAt(settings, "name"), stringAt(row, "creator_user_name"), numberAt(row, "job_id")];
}

export function filterDatabricksJobs(
  jobs: readonly unknown[],
  options: DatabricksSearchMatchOptions,
): unknown[] {
  return filterByQuery(jobs, { ...options, fields: fieldsOf });
}
