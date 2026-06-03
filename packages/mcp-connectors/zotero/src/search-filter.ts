import {
  asObjectish,
  makeQueryFilter,
  type SearchMatchOptions,
  stringField,
} from "../../shared/search-filter.ts";

export type ZoteroSearchMatchOptions = SearchMatchOptions;

function nonEmptyString(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function creatorName(c: unknown): string | null {
  if (c === null || typeof c !== "object") {
    return null;
  }
  const row = c as Record<string, unknown>;
  const name = nonEmptyString(row["name"]);
  if (name !== null) {
    return name;
  }
  const parts = [nonEmptyString(row["firstName"]), nonEmptyString(row["lastName"])].filter(
    (p): p is string => p !== null,
  );
  return parts.length > 0 ? parts.join(" ") : null;
}

function creatorNames(data: Record<string, unknown>): string {
  const creators = data["creators"];
  if (!Array.isArray(creators)) {
    return "";
  }
  const names: string[] = [];
  for (const c of creators) {
    const name = creatorName(c);
    if (name !== null) {
      names.push(name);
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
