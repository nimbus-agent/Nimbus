import {
  asObjectish,
  makeQueryFilter,
  type SearchMatchOptions,
  stringField,
} from "../../shared/search-filter.ts";

export type SalesforceSearchMatchOptions = SearchMatchOptions;

/**
 * Salesforce Opportunity records are flat objects with PascalCase fields:
 * `{ Id, Name, StageName, Amount, CloseDate, Type, ... }`. Match (case-insensitive
 * substring) against the opportunity name, its stage, and its type.
 */
function fieldsOf(item: unknown): readonly string[] | null {
  const row = asObjectish(item);
  if (row === undefined) {
    return null;
  }
  return [stringField(row, "Name"), stringField(row, "StageName"), stringField(row, "Type")];
}

export const filterSalesforceOpportunities = makeQueryFilter(fieldsOf);
