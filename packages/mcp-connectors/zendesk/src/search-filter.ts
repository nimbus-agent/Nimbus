import { asObjectish, filterByQuery, type SearchMatchOptions } from "../../shared/search-filter.ts";

export type ZendeskSearchMatchOptions = SearchMatchOptions;

function stringField(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : "";
}

function tagText(row: Record<string, unknown>): string {
  const tags = row["tags"];
  if (!Array.isArray(tags)) {
    return "";
  }
  const names: string[] = [];
  for (const t of tags) {
    if (typeof t === "string") {
      names.push(t);
    }
  }
  return names.join(" ");
}

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
