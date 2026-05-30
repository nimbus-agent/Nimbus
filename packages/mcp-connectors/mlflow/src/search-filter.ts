import { asRecord, filterByQuery, type SearchMatchOptions } from "../../shared/search-filter.ts";

export type MlflowSearchMatchOptions = SearchMatchOptions;

function stringAt(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : "";
}

function tagsHaystack(row: Record<string, unknown>): string {
  const tags = row["tags"];
  if (!Array.isArray(tags)) {
    return "";
  }
  const parts: string[] = [];
  for (const t of tags) {
    const tag = asRecord(t);
    if (tag === undefined) {
      continue;
    }
    parts.push(`${stringAt(tag, "key")}=${stringAt(tag, "value")}`);
  }
  return parts.join(" ");
}

function fieldsOf(item: unknown): readonly string[] | null {
  const row = asRecord(item);
  if (row === undefined) {
    return null;
  }
  return [stringAt(row, "name"), stringAt(row, "description"), tagsHaystack(row)];
}

export function filterMlflowModels(
  models: readonly unknown[],
  options: MlflowSearchMatchOptions,
): unknown[] {
  return filterByQuery(models, { ...options, fields: fieldsOf });
}
