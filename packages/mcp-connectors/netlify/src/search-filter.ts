import {
  asObjectish,
  makeQueryFilter,
  type SearchMatchOptions,
  stringField,
} from "../../shared/search-filter.ts";

export type NetlifySearchMatchOptions = SearchMatchOptions;

function subStringField(row: Record<string, unknown>, key: string, sub: string): string {
  const obj = row[key];
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return "";
  }
  const v = (obj as Record<string, unknown>)[sub];
  return typeof v === "string" ? v : "";
}

function fieldsOf(item: unknown): readonly string[] | null {
  const row = asObjectish(item);
  if (row === undefined) {
    return null;
  }
  return [
    stringField(row, "id"),
    stringField(row, "name"),
    stringField(row, "url"),
    stringField(row, "ssl_url"),
    subStringField(row, "build_settings", "repo_url"),
    subStringField(row, "build_settings", "repo_branch"),
    subStringField(row, "published_deploy", "state"),
    subStringField(row, "published_deploy", "branch"),
    subStringField(row, "published_deploy", "commit_ref"),
  ];
}

export const filterNetlifySites = makeQueryFilter(fieldsOf);
