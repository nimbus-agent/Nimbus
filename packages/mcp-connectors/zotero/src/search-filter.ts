import {
  asObjectish,
  makeQueryFilter,
  type SearchMatchOptions,
  stringField,
} from "../../shared/search-filter.ts";

export type ZoteroSearchMatchOptions = SearchMatchOptions;

function creatorNames(data: Record<string, unknown>): string {
  const creators = data["creators"];
  if (!Array.isArray(creators)) {
    return "";
  }
  const names: string[] = [];
  for (const c of creators) {
    if (c !== null && typeof c === "object") {
      const row = c as Record<string, unknown>;
      const last = row["lastName"];
      const first = row["firstName"];
      const name = row["name"];
      if (typeof name === "string" && name !== "") {
        names.push(name);
      } else {
        const parts: string[] = [];
        if (typeof first === "string" && first !== "") {
          parts.push(first);
        }
        if (typeof last === "string" && last !== "") {
          parts.push(last);
        }
        if (parts.length > 0) {
          names.push(parts.join(" "));
        }
      }
    }
  }
  return names.join(" ");
}

function tagNames(data: Record<string, unknown>): string {
  const tags = data["tags"];
  if (!Array.isArray(tags)) {
    return "";
  }
  const names: string[] = [];
  for (const t of tags) {
    if (t !== null && typeof t === "object") {
      const tag = (t as Record<string, unknown>)["tag"];
      if (typeof tag === "string") {
        names.push(tag);
      }
    }
  }
  return names.join(" ");
}

function fieldsOf(item: unknown): readonly string[] | null {
  const row = asObjectish(item);
  if (row === undefined) {
    return null;
  }
  const data = asObjectish(row["data"]);
  if (data === undefined) {
    return null;
  }
  return [
    stringField(data, "title"),
    stringField(data, "itemType"),
    stringField(data, "abstractNote"),
    stringField(data, "DOI"),
    stringField(data, "publicationTitle"),
    creatorNames(data),
    tagNames(data),
  ];
}

export const filterZoteroItems = makeQueryFilter(fieldsOf);
