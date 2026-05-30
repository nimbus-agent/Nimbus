import {
  asObjectish,
  filterByQuery,
  type SearchMatchOptions,
  stringField,
} from "../../shared/search-filter.ts";

export type MercurySearchMatchOptions = SearchMatchOptions;

function fieldsOf(item: unknown): readonly string[] | null {
  const row = asObjectish(item);
  if (row === undefined) {
    return null;
  }
  return [
    stringField(row, "id"),
    stringField(row, "name"),
    stringField(row, "status"),
    stringField(row, "type"),
    stringField(row, "kind"),
    stringField(row, "legalBusinessName"),
  ];
}

export function filterMercuryAccounts(
  accounts: readonly unknown[],
  options: MercurySearchMatchOptions,
): unknown[] {
  return filterByQuery(accounts, { ...options, fields: fieldsOf });
}
