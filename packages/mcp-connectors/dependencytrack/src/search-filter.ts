import {
  asObjectish,
  makeQueryFilter,
  type SearchMatchOptions,
  stringField,
  tagNamesFromObjects,
} from "../../shared/search-filter.ts";

export type DependencyTrackSearchMatchOptions = SearchMatchOptions;

function fieldsOf(item: unknown): readonly string[] | null {
  const row = asObjectish(item);
  if (row === undefined) {
    return null;
  }
  return [
    stringField(row, "name"),
    stringField(row, "version"),
    stringField(row, "classifier"),
    tagNamesFromObjects(row),
  ];
}

export const filterDependencyTrackProjects = makeQueryFilter(fieldsOf);
