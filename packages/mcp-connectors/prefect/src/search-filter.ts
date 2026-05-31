import {
  asObjectish,
  makeQueryFilter,
  type SearchMatchOptions,
  stringField,
} from "../../shared/search-filter.ts";

export type PrefectSearchMatchOptions = SearchMatchOptions;

/** Prefect deployment tags are a bare string array (not `{name}` objects). */
function tagNames(row: Record<string, unknown>): string {
  const tags = row["tags"];
  if (!Array.isArray(tags)) {
    return "";
  }
  const names: string[] = [];
  for (const t of tags) {
    if (typeof t === "string" && t !== "") {
      names.push(t);
    }
  }
  return names.join(" ");
}

function fieldsOf(item: unknown): readonly string[] | null {
  const row = asObjectish(item);
  if (row === undefined) {
    return null;
  }
  return [
    stringField(row, "name"),
    stringField(row, "description"),
    stringField(row, "work_pool_name"),
    stringField(row, "work_queue_name"),
    stringField(row, "status"),
    tagNames(row),
  ];
}

export const filterPrefectDeployments = makeQueryFilter(fieldsOf);
