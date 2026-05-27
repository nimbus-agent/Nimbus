/**
 * Pure substring-match filter for `stackoverflow_search`. Extracted from
 * `server.ts` so the matching logic can be unit-tested without spawning an MCP
 * stdio transport. The server keeps the HTTP / envelope wrapper; this module
 * owns the title/body/tags/owner-name haystack + case-insensitive substring
 * match.
 */

export interface StackOverflowSearchMatchOptions {
  readonly query: string;
  readonly limit?: number | undefined;
}

function stringField(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : "";
}

/**
 * Tag names from a Stack Overflow `tags: [...]` array. v3 tags may be objects
 * `{ name }` OR plain strings — both are tolerated (and non-object / non-string
 * entries skipped).
 */
function tagText(row: Record<string, unknown>): string {
  const tags = row["tags"];
  if (!Array.isArray(tags)) {
    return "";
  }
  const names: string[] = [];
  for (const t of tags) {
    if (typeof t === "string") {
      names.push(t);
    } else if (t !== null && typeof t === "object") {
      const name = (t as Record<string, unknown>)["name"];
      if (typeof name === "string") {
        names.push(name);
      }
    }
  }
  return names.join(" ");
}

/** Owner display name from a nested `owner: { name }` object, tolerating absence. */
function ownerName(row: Record<string, unknown>): string {
  const owner = row["owner"];
  if (owner === null || typeof owner !== "object") {
    return "";
  }
  const name = (owner as Record<string, unknown>)["name"];
  return typeof name === "string" ? name : "";
}

function buildHaystack(row: Record<string, unknown>): string {
  const title = stringField(row, "title");
  const body = stringField(row, "body");
  const bodyMarkdown = stringField(row, "bodyMarkdown");
  return `${title} ${body} ${bodyMarkdown} ${tagText(row)} ${ownerName(row)}`.toLowerCase();
}

export function filterStackOverflowQuestions(
  questions: readonly unknown[],
  options: StackOverflowSearchMatchOptions,
): unknown[] {
  const needle = options.query.toLowerCase();
  const cap = options.limit ?? 50;
  const out: unknown[] = [];
  for (const it of questions) {
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
