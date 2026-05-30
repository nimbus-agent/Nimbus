import {
  asObjectish,
  filterByQuery,
  type SearchMatchOptions,
  stringField,
  tagText,
} from "../../shared/search-filter.ts";

export type ZendeskSearchMatchOptions = SearchMatchOptions;

function fieldsOf(item: unknown): readonly string[] | null {
  const row = asObjectish(item);
  if (row === undefined) {
    return null;
  }
  return [
    stringField(row, "subject"),
    stringField(row, "description"),
    stringField(row, "status"),
    stringField(row, "priority"),
    stringField(row, "type"),
    tagText(row),
  ];
}

export function filterZendeskTickets(
  tickets: readonly unknown[],
  options: ZendeskSearchMatchOptions,
): unknown[] {
  return filterByQuery(tickets, { ...options, fields: fieldsOf });
}
