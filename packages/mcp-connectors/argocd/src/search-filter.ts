import {
  asRecord,
  makeQueryFilter,
  nestedString,
  type SearchMatchOptions,
} from "../../shared/search-filter.ts";

export type ArgocdSearchMatchOptions = SearchMatchOptions;

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
