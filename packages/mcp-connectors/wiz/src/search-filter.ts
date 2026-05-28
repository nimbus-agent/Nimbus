export interface WizSearchMatchOptions {
  readonly query: string;
  readonly limit?: number | undefined;
}

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

function buildHaystack(row: Record<string, unknown>): string {
  const ruleName = nestedString(row, "sourceRule", "name");
  const description = stringField(row, "description");
  const entityName = nestedString(row, "entity", "name");
  const entityType = nestedString(row, "entity", "type");
  const projects = projectNames(row);
  return `${ruleName} ${description} ${entityName} ${entityType} ${projects}`.toLowerCase();
}

export function filterWizIssues(
  issues: readonly unknown[],
  options: WizSearchMatchOptions,
): unknown[] {
  const needle = options.query.toLowerCase();
  const cap = options.limit ?? 50;
  const out: unknown[] = [];
  for (const it of issues) {
    if (it === null || typeof it !== "object") {
      continue;
    }
    const row = it as Record<string, unknown>;
    if (!buildHaystack(row).includes(needle)) {
      continue;
    }
    out.push(it);
    if (out.length >= cap) {
      break;
    }
  }
  return out;
}
