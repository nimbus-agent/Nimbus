/**
 * Pure substring-match filter for `netlify_search`. Extracted from `server.ts`
 * so the matching logic can be unit-tested without spawning an MCP stdio
 * transport. The server keeps the HTTP / envelope wrapper; this module owns the
 * id/name/url/ssl_url/repo/published-deploy haystack + case-insensitive
 * substring match.
 */

export interface NetlifySearchMatchOptions {
  readonly query: string;
  readonly limit?: number | undefined;
}

function stringField(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : "";
}

function subStringField(row: Record<string, unknown>, key: string, sub: string): string {
  const obj = row[key];
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return "";
  }
  const v = (obj as Record<string, unknown>)[sub];
  return typeof v === "string" ? v : "";
}

function buildHaystack(row: Record<string, unknown>): string {
  const id = stringField(row, "id");
  const name = stringField(row, "name");
  const url = stringField(row, "url");
  const sslUrl = stringField(row, "ssl_url");
  const repoUrl = subStringField(row, "build_settings", "repo_url");
  const repoBranch = subStringField(row, "build_settings", "repo_branch");
  const deployState = subStringField(row, "published_deploy", "state");
  const deployBranch = subStringField(row, "published_deploy", "branch");
  const commitRef = subStringField(row, "published_deploy", "commit_ref");
  return `${id} ${name} ${url} ${sslUrl} ${repoUrl} ${repoBranch} ${deployState} ${deployBranch} ${commitRef}`.toLowerCase();
}

export function filterNetlifySites(
  sites: readonly unknown[],
  options: NetlifySearchMatchOptions,
): unknown[] {
  const needle = options.query.toLowerCase();
  const cap = options.limit ?? 50;
  const out: unknown[] = [];
  for (const it of sites) {
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
