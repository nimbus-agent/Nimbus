/**
 * Pure substring-match filter for `dbt_search`. Extracted from `server.ts` so
 * the matching logic can be unit-tested without spawning an MCP stdio
 * transport. The server keeps the HTTP / envelope wrapper; this module owns
 * the name/dbt_version/id haystack + case-insensitive substring match.
 *
 * A dbt Cloud job object carries `id` (number), `name` (string), and
 * `dbt_version` (string, may be absent). The haystack stringifies whatever is
 * present so a numeric id still contributes; name remains the primary path.
 */

export interface DbtSearchMatchOptions {
  readonly query: string;
  readonly limit?: number | undefined;
}

function field(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  if (typeof v === "string") {
    return v;
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    return String(v);
  }
  return "";
}

function buildHaystack(row: Record<string, unknown>): string {
  const name = field(row, "name");
  const version = field(row, "dbt_version");
  const id = field(row, "id");
  return `${name} ${version} ${id}`.toLowerCase();
}

export function filterDbtJobs(jobs: readonly unknown[], options: DbtSearchMatchOptions): unknown[] {
  const needle = options.query.toLowerCase();
  const cap = options.limit ?? 50;
  const out: unknown[] = [];
  for (const it of jobs) {
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
