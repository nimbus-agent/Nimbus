/**
 * Pure substring-match filter for `sonarqube_search`. Extracted from
 * `server.ts` so the matching logic can be unit-tested without spawning an
 * MCP stdio transport. The server keeps the HTTP / envelope wrapper; this
 * module owns the message/rule/component haystack construction +
 * case-insensitive substring match.
 */

export interface SonarSearchMatchOptions {
  readonly query: string;
  readonly limit?: number | undefined;
}

function stringField(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((t): t is string => typeof t === "string") : [];
}

function buildHaystack(row: Record<string, unknown>): string {
  const tags = stringArray(row["tags"]);
  return `${stringField(row, "message")} ${stringField(row, "rule")} ${stringField(row, "component")} ${tags.join(" ")}`.toLowerCase();
}

export function filterSonarIssues(
  issues: readonly unknown[],
  options: SonarSearchMatchOptions,
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
