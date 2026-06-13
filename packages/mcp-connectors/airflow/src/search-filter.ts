import {
  asObjectish,
  makeQueryFilter,
  type SearchMatchOptions,
  stringField,
  tagNamesFromObjects,
} from "../../shared/search-filter.ts";

export type AirflowSearchMatchOptions = SearchMatchOptions;

function ownerNames(row: Record<string, unknown>): string {
  const owners = row["owners"];
  if (!Array.isArray(owners)) {
    return "";
  }
  const names: string[] = [];
  for (const o of owners) {
    if (typeof o === "string" && o !== "") {
      names.push(o);
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
    stringField(row, "dag_id"),
    stringField(row, "description"),
    ownerNames(row),
    tagNamesFromObjects(row),
  ];
}

export const filterAirflowDags = makeQueryFilter(fieldsOf);
