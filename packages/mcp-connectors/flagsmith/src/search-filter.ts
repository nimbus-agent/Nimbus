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
  return tags
    .filter((t): t is string | number => typeof t === "string" || typeof t === "number")
    .map(String)
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
