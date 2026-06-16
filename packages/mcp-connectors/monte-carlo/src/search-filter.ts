import {
  fieldsFromKeys,
  makeQueryFilter,
  type SearchMatchOptions,
} from "../../shared/search-filter.ts";

export type MonteCarloSearchMatchOptions = SearchMatchOptions;

export const filterMonteCarloIncidents = makeQueryFilter(
  fieldsFromKeys(["incidentId", "status", "severity", "monitoredTable"]),
);
