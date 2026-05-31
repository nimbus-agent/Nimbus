import {
  asObjectish,
  makeQueryFilter,
  type SearchMatchOptions,
  stringField,
} from "../../shared/search-filter.ts";

export type DependencyTrackSearchMatchOptions = SearchMatchOptions;

function tagNames(row: Record<string, unknown>): string {
  const tags = row["tags"];
  if (!Array.isArray(tags)) {
    return "";
  }
  const names: string[] = [];
  for (const t of tags) {
    const tag = asObjectish(t);
    if (tag === undefined) {
      continue;
    }
    const name = tag["name"];
    if (typeof name === "string" && name !== "") {
      names.push(name);
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
    stringField(row, "version"),
    stringField(row, "classifier"),
    tagNames(row),
  ];
}

export const filterDependencyTrackProjects = makeQueryFilter(fieldsOf);
