import {
  asObjectish,
  filterByQuery,
  type SearchMatchOptions,
  stringField,
} from "../../shared/search-filter.ts";

export type StripeSearchMatchOptions = SearchMatchOptions;

function fieldsOf(item: unknown): readonly string[] | null {
  const row = asObjectish(item);
  if (row === undefined) {
    return null;
  }
  return [
    stringField(row, "id"),
    stringField(row, "number"),
    stringField(row, "status"),
    stringField(row, "customer"),
    stringField(row, "customer_name"),
    stringField(row, "customer_email"),
    stringField(row, "description"),
  ];
}

export function filterStripeInvoices(
  invoices: readonly unknown[],
  options: StripeSearchMatchOptions,
): unknown[] {
  return filterByQuery(invoices, { ...options, fields: fieldsOf });
}
