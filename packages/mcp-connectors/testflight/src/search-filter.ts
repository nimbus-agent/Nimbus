import {
  asObjectish,
  type FieldExtractor,
  makeQueryFilter,
  type SearchMatchOptions,
  stringField,
} from "../../shared/search-filter.ts";

export type TestflightSearchMatchOptions = SearchMatchOptions;

/**
 * App Store Connect builds are JSON:API resources — the searchable fields live
 * under `attributes`, not at the top level. Project the version + processing
 * state up so the shared substring filter can match them.
 */
const buildFields: FieldExtractor = (item: unknown) => {
  const row = asObjectish(item);
  if (row === undefined) {
    return null;
  }
  const attributes = asObjectish(row["attributes"]) ?? {};
  return [
    stringField(attributes, "version"),
    stringField(attributes, "processingState"),
    stringField(attributes, "minOsVersion"),
    stringField(row, "id"),
  ];
};

export const filterTestflightBuilds = makeQueryFilter(buildFields);
