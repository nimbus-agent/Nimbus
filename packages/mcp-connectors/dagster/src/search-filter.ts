import {
  asObjectish,
  makeQueryFilter,
  type SearchMatchOptions,
  stringField,
} from "../../shared/search-filter.ts";

export type DagsterSearchMatchOptions = SearchMatchOptions;

/** Dagster pipeline tags are `{ key, value }` objects, not bare strings. */
function tagText(row: Record<string, unknown>): string {
  const tags = row["tags"];
  if (!Array.isArray(tags)) {
    return "";
  }
  const parts: string[] = [];
  for (const t of tags) {
    const tr = asObjectish(t);
    if (tr === undefined) {
      continue;
    }
    const key = stringField(tr, "key");
    const value = stringField(tr, "value");
    if (key !== "") {
      parts.push(key);
    }
    if (value !== "") {
      parts.push(value);
    }
  }
  return parts.join(" ");
}

/**
 * The connector flattens each job to a row carrying its name, repository,
 * location, plus the raw pipeline fields (description, tags). Search matches the
 * query against all of those.
 */
function fieldsOf(item: unknown): readonly string[] | null {
  const row = asObjectish(item);
  if (row === undefined) {
    return null;
  }
  return [
    stringField(row, "name"),
    stringField(row, "repository"),
    stringField(row, "location"),
    stringField(row, "description"),
    tagText(row),
  ];
}

export const filterDagsterJobs = makeQueryFilter(fieldsOf);
