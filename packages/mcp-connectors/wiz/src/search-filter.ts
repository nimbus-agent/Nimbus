import { asObjectish, filterByQuery, type SearchMatchOptions } from "../../shared/search-filter.ts";

export type WizSearchMatchOptions = SearchMatchOptions;

function stringField(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : "";
}

function nestedString(row: Record<string, unknown>, parent: string, key: string): string {
  const p = row[parent];
  if (p === null || typeof p !== "object") {
    return "";
  }
  return stringField(p as Record<string, unknown>, key);
}

function projectNames(row: Record<string, unknown>): string {
  const projects = row["projects"];
  if (!Array.isArray(projects)) {
    return "";
  }
  const names: string[] = [];
  for (const p of projects) {
    if (p === null || typeof p !== "object") {
      continue;
    }
    const name = stringField(p as Record<string, unknown>, "name");
    if (name !== "") {
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
  return [
    nestedString(row, "sourceRule", "name"),
    stringField(row, "description"),
    nestedString(row, "entity", "name"),
    nestedString(row, "entity", "type"),
    projectNames(row),
  ];
}

export function filterWizIssues(
  issues: readonly unknown[],
  options: WizSearchMatchOptions,
): unknown[] {
  return filterByQuery(issues, { ...options, fields: fieldsOf });
}
