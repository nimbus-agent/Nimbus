import { asRecord, makeQueryFilter, type SearchMatchOptions } from "../../shared/search-filter.ts";

export type ArgocdSearchMatchOptions = SearchMatchOptions;

function nestedString(root: Record<string, unknown>, path: readonly string[]): string {
  let cur: Record<string, unknown> | undefined = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    cur = asRecord(cur?.[path[i] ?? ""]);
    if (cur === undefined) {
      return "";
    }
  }
  const leaf = cur?.[path.at(-1) ?? ""];
  return typeof leaf === "string" ? leaf : "";
}

function fieldsOf(item: unknown): readonly string[] | null {
  const row = asRecord(item);
  if (row === undefined) {
    return null;
  }
  return [
    nestedString(row, ["metadata", "name"]),
    nestedString(row, ["spec", "project"]),
    nestedString(row, ["spec", "source", "repoURL"]),
    nestedString(row, ["status", "sync", "status"]),
    nestedString(row, ["status", "health", "status"]),
  ];
}

export const filterArgocdApplications = makeQueryFilter(fieldsOf);
