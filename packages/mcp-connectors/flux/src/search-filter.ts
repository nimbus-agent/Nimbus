import { asRecord, filterByQuery, type SearchMatchOptions } from "../../shared/search-filter.ts";

export type FluxSearchMatchOptions = SearchMatchOptions;

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

export function filterFluxResources(
  items: readonly unknown[],
  options: FluxSearchMatchOptions,
): unknown[] {
  return filterByQuery(items, { ...options, fields: fieldsOf });
}
