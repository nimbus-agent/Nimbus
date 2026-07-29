import {
  fieldsFromKeys,
  makeQueryFilter,
  type SearchMatchOptions,
} from "../../shared/search-filter.ts";

export type RaindropSearchMatchOptions = SearchMatchOptions;

export const filterRaindropBookmarks = makeQueryFilter(
  fieldsFromKeys(["title", "excerpt", "note", "domain", "link", "type"], { tags: true }),
);

/**
 * Collection haystack: the title and the two display fields. The Raindrop
 * Collection object has no description, and `cover` / `access` / `collaborators`
 * are noise, so the title carries almost all the signal.
 */
export const filterRaindropCollections = makeQueryFilter(
  fieldsFromKeys(["title", "view", "color"]),
);
