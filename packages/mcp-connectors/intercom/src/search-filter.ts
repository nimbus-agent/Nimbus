import {
  asObjectish,
  asRecord,
  filterByQuery,
  type SearchMatchOptions,
} from "../../shared/search-filter.ts";

export type IntercomSearchMatchOptions = SearchMatchOptions;

function stringField(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : "";
}

function tagText(row: Record<string, unknown>): string {
  const tags = asRecord(row["tags"]);
  const list = tags === undefined ? undefined : tags["tags"];
  if (!Array.isArray(list)) {
    return "";
  }
  const names: string[] = [];
  for (const t of list) {
    const obj = asRecord(t);
    if (obj === undefined) {
      continue;
    }
    const name = obj["name"];
    if (typeof name === "string") {
      names.push(name);
    }
  }
  return names.join(" ");
}

function fieldsOf(item: unknown): readonly string[] | null {
  const row = asObjectish(item);
  if (row === undefined) {
    return null;
  }
  const state = stringField(row, "state");
  const source = asRecord(row["source"]) ?? {};
  const subject = stringField(source, "subject");
  const body = stringField(source, "body");
  const author = asRecord(source["author"]) ?? {};
  const authorName = stringField(author, "name");
  const authorEmail = stringField(author, "email");
  return [subject, body, state, authorName, authorEmail, tagText(row)];
}

export function filterIntercomConversations(
  conversations: readonly unknown[],
  options: IntercomSearchMatchOptions,
): unknown[] {
  return filterByQuery(conversations, { ...options, fields: fieldsOf });
}
