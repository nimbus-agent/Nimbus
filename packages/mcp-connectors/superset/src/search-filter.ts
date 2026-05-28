/**
 * Pure substring-match filter for `superset_search`. Extracted from
 * `server.ts` so the matching logic can be unit-tested without spawning an
 * MCP stdio transport. The server keeps the HTTP / login / envelope wrapper;
 * this module owns the haystack + case-insensitive substring match.
 *
 * A Superset dashboard object is flat: the haystack is built from
 * `dashboard_title` and `slug`.
 */

export interface SupersetSearchMatchOptions {
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

function buildHaystack(row: Record<string, unknown>): string {
  return [stringAt(row, "dashboard_title"), stringAt(row, "slug")].join(" ").toLowerCase();
}

export function filterSupersetDashboards(
  dashboards: readonly unknown[],
  options: SupersetSearchMatchOptions,
): unknown[] {
  const needle = options.query.toLowerCase();
  const cap = options.limit ?? 50;
  const out: unknown[] = [];
  for (const it of dashboards) {
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
