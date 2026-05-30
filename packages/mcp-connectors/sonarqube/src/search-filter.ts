import {
  asObjectish,
  filterByQuery,
  type SearchMatchOptions,
  stringField,
} from "../../shared/search-filter.ts";

export type SonarSearchMatchOptions = SearchMatchOptions;

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
