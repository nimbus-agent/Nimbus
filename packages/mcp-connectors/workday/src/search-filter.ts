import { fieldsFromKeys, makeQueryFilter } from "../../shared/search-filter.ts";

export const filterWorkdayWorkers = makeQueryFilter(
  fieldsFromKeys(["descriptor", "title", "team", "department", "location"]),
);
