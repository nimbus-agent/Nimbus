import {
  asObjectish,
  makeQueryFilter,
  type SearchMatchOptions,
  stringField,
} from "../../shared/search-filter.ts";

export type StackOverflowSearchMatchOptions = SearchMatchOptions;

function tagText(row: Record<string, unknown>): string {
  const tags = row["tags"];
  if (!Array.isArray(tags)) {
    return "";
  }
  const names: string[] = [];
  for (const t of tags) {
    if (typeof t === "string") {
      names.push(t);
    } else if (t !== null && typeof t === "object") {
      const name = (t as Record<string, unknown>)["name"];
      if (typeof name === "string") {
        names.push(name);
      }
    }
  }
  return names.join(" ");
}

function ownerName(row: Record<string, unknown>): string {
  const owner = row["owner"];
  if (owner === null || typeof owner !== "object") {
    return "";
  }
  const name = (owner as Record<string, unknown>)["name"];
  return typeof name === "string" ? name : "";
}

function fieldsOf(item: unknown): readonly string[] | null {
  const row = asObjectish(item);
  if (row === undefined) {
    return null;
  }
  return [
    stringField(row, "title"),
    stringField(row, "body"),
    stringField(row, "bodyMarkdown"),
    tagText(row),
    ownerName(row),
  ];
}

export const filterStackOverflowQuestions = makeQueryFilter(fieldsOf);
