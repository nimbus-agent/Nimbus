import {
  fieldsFromKeys,
  makeQueryFilter,
  type SearchMatchOptions,
} from "../../shared/search-filter.ts";

export type PipedriveSearchMatchOptions = SearchMatchOptions;

export const filterPipedriveDeals = makeQueryFilter(
  fieldsFromKeys(["title", "status", "org_name", "person_name", "owner_name", "label"]),
);
