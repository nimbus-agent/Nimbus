import { stringField } from "../../shared/search-filter.ts";

export interface ZoomSearchOptions {
  readonly query: string;
  readonly limit?: number;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
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
