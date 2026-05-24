/**
 * Pure substring-match filter for `launchdarkly_search`. Extracted from
 * `server.ts` so the matching logic can be unit-tested without spawning an
 * MCP stdio transport. The server keeps the HTTP / envelope wrapper; this
 * module owns the key/name/description/tags haystack + case-insensitive
 * substring match.
 */

export interface LaunchDarklySearchMatchOptions {
  readonly query: string;
  readonly limit?: number | undefined;
}

function stringField(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : "";
}

function tagsString(row: Record<string, unknown>): string {
  const tags = row["tags"];
  if (!Array.isArray(tags)) {
    return "";
  }
  return tags.filter((t): t is string => typeof t === "string").join(" ");
}

function buildHaystack(row: Record<string, unknown>): string {
  const key = stringField(row, "key");
  const name = stringField(row, "name");
  const description = stringField(row, "description");
  return `${key} ${name} ${description} ${tagsString(row)}`.toLowerCase();
}

export function filterLaunchDarklyFlags(
  flags: readonly unknown[],
  options: LaunchDarklySearchMatchOptions,
): unknown[] {
  const needle = options.query.toLowerCase();
  const cap = options.limit ?? 50;
  const out: unknown[] = [];
  for (const it of flags) {
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
