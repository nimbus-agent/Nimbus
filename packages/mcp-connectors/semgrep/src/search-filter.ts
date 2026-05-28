export interface SemgrepSearchMatchOptions {
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

function buildHaystack(row: Record<string, unknown>): string {
  const ruleName = stringField(row, "rule_name");
  const ruleMessage = stringField(row, "rule_message");
  const filePath = nestedString(row, "location", "file_path");
  const repoName = nestedString(row, "repository", "name");
  return `${ruleName} ${ruleMessage} ${filePath} ${repoName}`.toLowerCase();
}

export function filterSemgrepFindings(
  findings: readonly unknown[],
  options: SemgrepSearchMatchOptions,
): unknown[] {
  const needle = options.query.toLowerCase();
  const cap = options.limit ?? 50;
  const out: unknown[] = [];
  for (const it of findings) {
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
