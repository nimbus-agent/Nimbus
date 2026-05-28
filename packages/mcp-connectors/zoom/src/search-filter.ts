/**
 * Pure substring search over a Zoom meetings list. The MCP server uses this
 * to power `zoom_search` against the first page of `GET /v2/users/me/meetings`
 * — no API call is made (the search is local to the already-fetched page).
 */

export interface ZoomSearchOptions {
  readonly query: string;
  readonly limit?: number;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function stringField(r: Record<string, unknown>, k: string): string {
  const v = r[k];
  return typeof v === "string" ? v : "";
}

export function filterZoomMeetings(
  meetings: readonly unknown[],
  options: ZoomSearchOptions,
): unknown[] {
  const q = options.query.trim().toLowerCase();
  if (q === "") {
    return [];
  }
  const limit = options.limit ?? 50;
  if (limit <= 0) {
    return [];
  }
  const matches: unknown[] = [];
  for (const m of meetings) {
    const row = asRecord(m);
    if (row === undefined) {
      continue;
    }
    const haystack =
      `${stringField(row, "topic")} ${stringField(row, "agenda")} ${stringField(row, "host_id")}`.toLowerCase();
    if (haystack.includes(q)) {
      matches.push(m);
      if (matches.length >= limit) {
        break;
      }
    }
  }
  return matches;
}
