import { asObjectish, filterByQuery, type SearchMatchOptions } from "../../shared/search-filter.ts";

export type DbtSearchMatchOptions = SearchMatchOptions;

function field(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  if (typeof v === "string") {
    return v;
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    return String(v);
  }
  return "";
}

function fieldsOf(item: unknown): readonly string[] | null {
  const row = asObjectish(item);
  if (row === undefined) {
    return null;
  }
  return [field(row, "name"), field(row, "dbt_version"), field(row, "id")];
}

export function filterDbtJobs(jobs: readonly unknown[], options: DbtSearchMatchOptions): unknown[] {
  return filterByQuery(jobs, { ...options, fields: fieldsOf });
}
