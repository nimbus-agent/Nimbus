import {
  fieldsFromKeys,
  makeQueryFilter,
  type SearchMatchOptions,
} from "../../shared/search-filter.ts";

export type CodemagicSearchMatchOptions = SearchMatchOptions;

export const filterCodemagicBuilds = makeQueryFilter(
  fieldsFromKeys(["branch", "message", "workflowId", "status"]),
);
