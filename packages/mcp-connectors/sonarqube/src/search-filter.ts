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
    const message = typeof row["message"] === "string" ? (row["message"] as string) : "";
    const rule = typeof row["rule"] === "string" ? (row["rule"] as string) : "";
    const component = typeof row["component"] === "string" ? (row["component"] as string) : "";
    const tagsField = row["tags"];
    const tags = Array.isArray(tagsField)
      ? tagsField.filter((t): t is string => typeof t === "string")
      : [];
    const hay = `${message} ${rule} ${component} ${tags.join(" ")}`.toLowerCase();
    if (hay.includes(needle)) {
      out.push(it);
      if (out.length >= cap) {
        break;
      }
    }
  }
  return out;
}
