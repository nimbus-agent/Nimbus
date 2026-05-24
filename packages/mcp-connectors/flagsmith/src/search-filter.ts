/**
 * Pure substring-match filter for `flagsmith_search`. Extracted from
 * `server.ts` so the matching logic can be unit-tested without spawning an
 * MCP stdio transport. The server keeps the HTTP / envelope wrapper; this
 * module owns the name/description/tags haystack + case-insensitive
 * substring match.
 */

export interface FlagsmithSearchMatchOptions {
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
  // Flagsmith feature tags arrive as numeric ids here (labels are resolved
  // gateway-side); stringify whatever is present so a numeric/string tag id
  // still contributes to the haystack. Name + description remain the primary
  // matching path.
  return tags
    .filter((t): t is string | number => typeof t === "string" || typeof t === "number")
    .map((t) => String(t))
    .join(" ");
}

function buildHaystack(row: Record<string, unknown>): string {
  const name = stringField(row, "name");
  const description = stringField(row, "description");
  return `${name} ${description} ${tagsString(row)}`.toLowerCase();
}

export function filterFlagsmithFeatures(
  features: readonly unknown[],
  options: FlagsmithSearchMatchOptions,
): unknown[] {
  const needle = options.query.toLowerCase();
  const cap = options.limit ?? 50;
  const out: unknown[] = [];
  for (const it of features) {
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
