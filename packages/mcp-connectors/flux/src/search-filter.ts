import {
  asRecord,
  makeQueryFilter,
  nestedString,
  type SearchMatchOptions,
} from "../../shared/search-filter.ts";

export type FluxSearchMatchOptions = SearchMatchOptions;

function readyConditionText(row: Record<string, unknown>): string {
  const status = asRecord(row["status"]);
  const conditions = status?.["conditions"];
  if (!Array.isArray(conditions)) {
    return "";
  }
  for (const entry of conditions) {
    const c = asRecord(entry);
    if (c === undefined) {
      continue;
    }
    if (c["type"] === "Ready") {
      const reason = typeof c["reason"] === "string" ? c["reason"] : "";
      const message = typeof c["message"] === "string" ? c["message"] : "";
      return `${reason} ${message}`;
    }
  }
  return "";
}

function fieldsOf(item: unknown): readonly string[] | null {
  const row = asRecord(item);
  if (row === undefined) {
    return null;
  }
  return [
    nestedString(row, ["metadata", "name"]),
    nestedString(row, ["metadata", "namespace"]),
    readyConditionText(row),
  ];
}

export const filterFluxResources = makeQueryFilter(fieldsOf);
