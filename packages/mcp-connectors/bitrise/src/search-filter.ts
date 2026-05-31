import {
  fieldsFromKeys,
  makeQueryFilter,
  type SearchMatchOptions,
} from "../../shared/search-filter.ts";

export type BitriseSearchMatchOptions = SearchMatchOptions;

export const filterBitriseBuilds = makeQueryFilter(
  fieldsFromKeys(["branch", "commit_message", "triggered_workflow", "status_text"]),
);
