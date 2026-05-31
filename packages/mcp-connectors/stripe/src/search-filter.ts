import {
  fieldsFromKeys,
  makeQueryFilter,
  type SearchMatchOptions,
} from "../../shared/search-filter.ts";

export type StripeSearchMatchOptions = SearchMatchOptions;

export const filterStripeInvoices = makeQueryFilter(
  fieldsFromKeys([
    "id",
    "number",
    "status",
    "customer",
    "customer_name",
    "customer_email",
    "description",
  ]),
);
