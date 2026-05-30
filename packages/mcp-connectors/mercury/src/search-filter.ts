import {
  fieldsFromKeys,
  makeQueryFilter,
  type SearchMatchOptions,
} from "../../shared/search-filter.ts";

export type MercurySearchMatchOptions = SearchMatchOptions;

export const filterMercuryAccounts = makeQueryFilter(
  fieldsFromKeys(["id", "name", "status", "type", "kind", "legalBusinessName"]),
);
