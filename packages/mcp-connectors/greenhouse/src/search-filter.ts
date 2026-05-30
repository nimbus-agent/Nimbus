import {
  asObjectish,
  makeQueryFilter,
  type SearchMatchOptions,
  stringField,
} from "../../shared/search-filter.ts";

export type GreenhouseSearchMatchOptions = SearchMatchOptions;

function namedArrayText(row: Record<string, unknown>, key: string): string {
  const arr = row[key];
  if (!Array.isArray(arr)) {
    return "";
  }
  const names: string[] = [];
  for (const e of arr) {
    if (e === null || typeof e !== "object" || Array.isArray(e)) {
      continue;
    }
    const name = (e as Record<string, unknown>)["name"];
    if (typeof name === "string") {
      names.push(name);
    }
  }
  return names.join(" ");
}

function officeLocationText(row: Record<string, unknown>): string {
  const arr = row["offices"];
  if (!Array.isArray(arr)) {
    return "";
  }
  const locs: string[] = [];
  for (const e of arr) {
    if (e === null || typeof e !== "object" || Array.isArray(e)) {
      continue;
    }
    const loc = (e as Record<string, unknown>)["location"];
    if (loc === null || typeof loc !== "object" || Array.isArray(loc)) {
      continue;
    }
    const name = (loc as Record<string, unknown>)["name"];
    if (typeof name === "string") {
      locs.push(name);
    }
  }
  return locs.join(" ");
}

function fieldsOf(item: unknown): readonly string[] | null {
  const row = asObjectish(item);
  if (row === undefined) {
    return null;
  }
  return [
    stringField(row, "name"),
    stringField(row, "status"),
    stringField(row, "requisition_id"),
    namedArrayText(row, "departments"),
    namedArrayText(row, "offices"),
    officeLocationText(row),
  ];
}

export const filterGreenhouseJobs = makeQueryFilter(fieldsOf);
