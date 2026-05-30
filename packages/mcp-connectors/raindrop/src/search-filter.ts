import {
  fieldsFromKeys,
  makeQueryFilter,
  type SearchMatchOptions,
} from "../../shared/search-filter.ts";

export type RaindropSearchMatchOptions = SearchMatchOptions;

export const filterRaindropBookmarks = makeQueryFilter(
  fieldsFromKeys(["title", "excerpt", "note", "domain", "link", "type"], { tags: true }),
);
