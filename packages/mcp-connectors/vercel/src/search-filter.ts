import { asObjectish, filterByQuery, type SearchMatchOptions } from "../../shared/search-filter.ts";

export type VercelSearchMatchOptions = SearchMatchOptions;

function stringField(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : "";
}

function commitMessage(row: Record<string, unknown>): string {
  const meta = row["meta"];
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
    return "";
  }
  const v = (meta as Record<string, unknown>)["githubCommitMessage"];
  return typeof v === "string" ? v : "";
}

function fieldsOf(item: unknown): readonly string[] | null {
  const row = asObjectish(item);
  if (row === undefined) {
    return null;
  }
  return [
    stringField(row, "uid"),
    stringField(row, "name"),
    stringField(row, "state"),
    stringField(row, "target"),
    stringField(row, "url"),
    commitMessage(row),
  ];
}

export function filterVercelDeployments(
  deployments: readonly unknown[],
  options: VercelSearchMatchOptions,
): unknown[] {
  return filterByQuery(deployments, { ...options, fields: fieldsOf });
}
