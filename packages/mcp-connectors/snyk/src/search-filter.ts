/**
 * Pure substring-match filter for `snyk_search`. Extracted from `server.ts`
 * so the matching logic can be unit-tested without spawning an MCP stdio
 * transport. The server keeps the HTTP / envelope wrapper; this module
 * owns the title/cve/pkg haystack construction + case-insensitive
 * substring match.
 */

export interface SnykSearchMatchOptions {
  readonly query: string;
  readonly limit?: number | undefined;
}

export function filterSnykAggregatedIssues(
  issues: readonly unknown[],
  options: SnykSearchMatchOptions,
): unknown[] {
  const needle = options.query.toLowerCase();
  const cap = options.limit ?? 50;
  const out: unknown[] = [];
  for (const it of issues) {
    if (it === null || typeof it !== "object") {
      continue;
    }
    const row = it as Record<string, unknown>;
    const dataField = row["issueData"];
    const data =
      dataField !== null && typeof dataField === "object"
        ? (dataField as Record<string, unknown>)
        : {};
    const title = typeof data["title"] === "string" ? (data["title"] as string) : "";
    const cveField = data["cve"];
    const cves = Array.isArray(cveField)
      ? cveField.filter((c): c is string => typeof c === "string")
      : [];
    const pkg = typeof row["pkgName"] === "string" ? (row["pkgName"] as string) : "";
    const hay = `${title} ${cves.join(" ")} ${pkg}`.toLowerCase();
    if (hay.includes(needle)) {
      out.push(it);
      if (out.length >= cap) {
        break;
      }
    }
  }
  return out;
}
