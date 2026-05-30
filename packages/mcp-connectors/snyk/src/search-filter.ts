import { asObjectish, filterByQuery, type SearchMatchOptions } from "../../shared/search-filter.ts";

export type SnykSearchMatchOptions = SearchMatchOptions;

function fieldsOf(item: unknown): readonly string[] | null {
  const row = asObjectish(item);
  if (row === undefined) {
    return null;
  }
  const dataField = row["issueData"];
  const data =
    dataField !== null && typeof dataField === "object"
      ? (dataField as Record<string, unknown>)
      : {};
  const title = typeof data["title"] === "string" ? data["title"] : "";
  const cveField = data["cve"];
  const cves = Array.isArray(cveField)
    ? cveField.filter((c): c is string => typeof c === "string")
    : [];
  const pkg = typeof row["pkgName"] === "string" ? row["pkgName"] : "";
  return [title, cves.join(" "), pkg];
}

export function filterSnykAggregatedIssues(
  issues: readonly unknown[],
  options: SnykSearchMatchOptions,
): unknown[] {
  return filterByQuery(issues, { ...options, fields: fieldsOf });
}
