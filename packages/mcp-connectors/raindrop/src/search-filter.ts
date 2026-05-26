/**
 * Pure substring-match filter for `raindrop_search`. Extracted from `server.ts`
 * so the matching logic can be unit-tested without spawning an MCP stdio
 * transport. The server keeps the HTTP / envelope wrapper; this module owns the
 * title/excerpt/note/domain/link/type/tag haystack + case-insensitive substring
 * match.
 */

export interface RaindropSearchMatchOptions {
  readonly query: string;
  readonly limit?: number | undefined;
}

function stringField(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : "";
}

/** Tag strings from a Raindrop `tags: ["a", "b"]` array, tolerating non-strings. */
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
  const title = stringField(row, "title");
  const excerpt = stringField(row, "excerpt");
  const note = stringField(row, "note");
  const domain = stringField(row, "domain");
  const link = stringField(row, "link");
  const type = stringField(row, "type");
  return `${title} ${excerpt} ${note} ${domain} ${link} ${type} ${tagText(row)}`.toLowerCase();
}

export function filterRaindropBookmarks(
  bookmarks: readonly unknown[],
  options: RaindropSearchMatchOptions,
): unknown[] {
  const needle = options.query.toLowerCase();
  const cap = options.limit ?? 50;
  const out: unknown[] = [];
  for (const it of bookmarks) {
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
