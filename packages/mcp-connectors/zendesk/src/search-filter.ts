import {
  fieldsFromKeys,
  makeQueryFilter,
  type SearchMatchOptions,
} from "../../shared/search-filter.ts";

export type ZendeskSearchMatchOptions = SearchMatchOptions;

export const filterZendeskTickets = makeQueryFilter(
  fieldsFromKeys(["subject", "description", "status", "priority", "type"], { tags: true }),
);
