/**
 * Pure substring-match filter for `zendesk_search`. Extracted from `server.ts`
 * so the matching logic can be unit-tested without spawning an MCP stdio
 * transport. The server keeps the HTTP / envelope wrapper; this module owns the
 * subject/description/status/priority/type/tag haystack + case-insensitive
 * substring match.
 */

export interface ZendeskSearchMatchOptions {
  readonly query: string;
  readonly limit?: number | undefined;
}

function stringField(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : "";
}

/** Tag strings from a Zendesk `tags: ["a", "b"]` array, tolerating non-strings. */
function tagText(row: Record<string, unknown>): string {
  const tags = row["tags"];
  if (!Array.isArray(tags)) {
    return "";
  }
  const names: string[] = [];
  for (const t of tags) {
    if (typeof t === "string") {
      names.push(t);
    }
  }
  return names.join(" ");
}

function buildHaystack(row: Record<string, unknown>): string {
  const subject = stringField(row, "subject");
  const description = stringField(row, "description");
  const status = stringField(row, "status");
  const priority = stringField(row, "priority");
  const type = stringField(row, "type");
  return `${subject} ${description} ${status} ${priority} ${type} ${tagText(row)}`.toLowerCase();
}

export function filterZendeskTickets(
  tickets: readonly unknown[],
  options: ZendeskSearchMatchOptions,
): unknown[] {
  const needle = options.query.toLowerCase();
  const cap = options.limit ?? 50;
  const out: unknown[] = [];
  for (const it of tickets) {
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
