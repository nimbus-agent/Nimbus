/**
 * Pure substring-match filter for `vercel_search`. Extracted from `server.ts`
 * so the matching logic can be unit-tested without spawning an MCP stdio
 * transport. The server keeps the HTTP / envelope wrapper; this module owns the
 * name/state/target/url/commit-message haystack + case-insensitive substring
 * match.
 */

export interface VercelSearchMatchOptions {
  readonly query: string;
  readonly limit?: number | undefined;
}

function stringField(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : "";
}

function commitMessage(row: Record<string, unknown>): string {
  const meta = row["meta"];
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
    return "";
  }
  const v = (meta as Record<string, unknown>)["githubCommitMessage"];
  return typeof v === "string" ? v : "";
}

function buildHaystack(row: Record<string, unknown>): string {
  const uid = stringField(row, "uid");
  const name = stringField(row, "name");
  const state = stringField(row, "state");
  const target = stringField(row, "target");
  const url = stringField(row, "url");
  return `${uid} ${name} ${state} ${target} ${url} ${commitMessage(row)}`.toLowerCase();
}

export function filterVercelDeployments(
  deployments: readonly unknown[],
  options: VercelSearchMatchOptions,
): unknown[] {
  const needle = options.query.toLowerCase();
  const cap = options.limit ?? 50;
  const out: unknown[] = [];
  for (const it of deployments) {
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
