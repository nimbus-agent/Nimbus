import {
  asObjectish,
  type FieldExtractor,
  makeQueryFilter,
  type SearchMatchOptions,
  stringField,
} from "../../shared/search-filter.ts";

export type FirebaseSearchMatchOptions = SearchMatchOptions;

/**
 * App Distribution `releases[]` resources carry their searchable fields at the
 * top level, except release notes which nest under `releaseNotes.text`. Project
 * those up so the shared substring filter can match them.
 */
const releaseFields: FieldExtractor = (item: unknown) => {
  const row = asObjectish(item);
  if (row === undefined) {
    return null;
  }
  const releaseNotes = asObjectish(row["releaseNotes"]) ?? {};
  return [
    stringField(row, "displayVersion"),
    stringField(row, "buildVersion"),
    stringField(releaseNotes, "text"),
    stringField(row, "name"),
  ];
};

export const filterFirebaseReleases = makeQueryFilter(releaseFields);
