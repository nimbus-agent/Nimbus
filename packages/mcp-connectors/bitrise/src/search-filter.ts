import { asObjectish, filterByQuery, type SearchMatchOptions } from "../../shared/search-filter.ts";

export type BitriseSearchMatchOptions = SearchMatchOptions;

function pickString(r: Record<string, unknown>, key: string): string {
  const v = r[key];
  return typeof v === "string" ? v : "";
}

function fieldsOf(item: unknown): readonly string[] | null {
  const row = asObjectish(item);
  if (row === undefined) {
    return null;
  }
  return [
    pickString(row, "branch"),
    pickString(row, "commit_message"),
    pickString(row, "triggered_workflow"),
    pickString(row, "status_text"),
  ];
}

export function filterBitriseBuilds(
  builds: readonly unknown[],
  options: BitriseSearchMatchOptions,
): unknown[] {
  return filterByQuery(builds, { ...options, fields: fieldsOf });
}
