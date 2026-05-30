import { asObjectish, filterByQuery, type SearchMatchOptions } from "../../shared/search-filter.ts";

export type SonarSearchMatchOptions = SearchMatchOptions;

function stringField(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((t): t is string => typeof t === "string") : [];
}

function fieldsOf(item: unknown): readonly string[] | null {
  const row = asObjectish(item);
  if (row === undefined) {
    return null;
  }
  const tags = stringArray(row["tags"]);
  return [
    stringField(row, "message"),
    stringField(row, "rule"),
    stringField(row, "component"),
    tags.join(" "),
  ];
}

export function filterSonarIssues(
  issues: readonly unknown[],
  options: SonarSearchMatchOptions,
): unknown[] {
  return filterByQuery(issues, { ...options, fields: fieldsOf });
}
