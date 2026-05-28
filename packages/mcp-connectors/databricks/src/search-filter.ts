/**
 * Pure substring-match filter for `databricks_search`. Extracted from
 * `server.ts` so the matching logic can be unit-tested without spawning an
 * MCP stdio transport. The server keeps the HTTP / envelope wrapper; this
 * module owns the haystack + case-insensitive substring match.
 *
 * A Databricks Jobs API 2.1 job object is nested: the human name lives at
 * `settings.name`, the owner at `creator_user_name`, and the id at `job_id`.
 * The haystack is built from all three.
 */

export interface DatabricksSearchMatchOptions {
  readonly query: string;
  readonly limit?: number | undefined;
}

/** Non-array plain object, or undefined. */
function asObject(v: unknown): Record<string, unknown> | undefined {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    return undefined;
  }
  return v as Record<string, unknown>;
}

function stringAt(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : "";
}

function numberAt(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === "number" && Number.isFinite(v) ? String(v) : "";
}

function buildHaystack(row: Record<string, unknown>): string {
  const settings = asObject(row["settings"]) ?? {};
  return [stringAt(settings, "name"), stringAt(row, "creator_user_name"), numberAt(row, "job_id")]
    .join(" ")
    .toLowerCase();
}

export function filterDatabricksJobs(
  jobs: readonly unknown[],
  options: DatabricksSearchMatchOptions,
): unknown[] {
  const needle = options.query.toLowerCase();
  const cap = options.limit ?? 50;
  const out: unknown[] = [];
  for (const it of jobs) {
    const row = asObject(it);
    if (row === undefined) {
      continue;
    }
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
