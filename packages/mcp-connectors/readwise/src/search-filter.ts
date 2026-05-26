/**
 * Pure substring-match filter for `readwise_search`. Extracted from `server.ts`
 * so the matching logic can be unit-tested without spawning an MCP stdio
 * transport. The server keeps the HTTP / envelope wrapper; this module owns the
 * text/note/color/location_type/tag-name haystack + case-insensitive substring
 * match.
 */

export interface ReadwiseSearchMatchOptions {
  readonly query: string;
  readonly limit?: number | undefined;
}

function stringField(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : "";
}

/** Tag names from a Readwise `tags: [{ id, name }]` array, tolerating non-objects. */
function tagNames(row: Record<string, unknown>): string {
  const tags = row["tags"];
  if (!Array.isArray(tags)) {
    return "";
  }
  const names: string[] = [];
  for (const t of tags) {
    if (t !== null && typeof t === "object") {
      const name = (t as Record<string, unknown>)["name"];
      if (typeof name === "string") {
        names.push(name);
      }
    }
  }
  return names.join(" ");
}

function buildHaystack(row: Record<string, unknown>): string {
  const text = stringField(row, "text");
  const note = stringField(row, "note");
  const color = stringField(row, "color");
  const locationType = stringField(row, "location_type");
  return `${text} ${note} ${color} ${locationType} ${tagNames(row)}`.toLowerCase();
}

export function filterReadwiseHighlights(
  highlights: readonly unknown[],
  options: ReadwiseSearchMatchOptions,
): unknown[] {
  const needle = options.query.toLowerCase();
  const cap = options.limit ?? 50;
  const out: unknown[] = [];
  for (const it of highlights) {
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
