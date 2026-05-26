/**
 * Pure substring-match filter for `mlflow_search`. Extracted from
 * `server.ts` so the matching logic can be unit-tested without spawning an
 * MCP stdio transport. The server keeps the HTTP / envelope wrapper; this
 * module owns the haystack + case-insensitive substring match.
 *
 * An MLflow Model Registry `RegisteredModel` object carries the human name at
 * `name`, the free-text `description`, and `tags` as a `{ key, value }[]`
 * array. The haystack is built from the name, the description, and the
 * flattened `key=value` tag pairs.
 */

export interface MlflowSearchMatchOptions {
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

/** Flatten a `{ key, value }[]` tag array into space-joined `key=value` pairs. */
function tagsHaystack(row: Record<string, unknown>): string {
  const tags = row["tags"];
  if (!Array.isArray(tags)) {
    return "";
  }
  const parts: string[] = [];
  for (const t of tags) {
    const tag = asObject(t);
    if (tag === undefined) {
      continue;
    }
    parts.push(`${stringAt(tag, "key")}=${stringAt(tag, "value")}`);
  }
  return parts.join(" ");
}

function buildHaystack(row: Record<string, unknown>): string {
  return [stringAt(row, "name"), stringAt(row, "description"), tagsHaystack(row)]
    .join(" ")
    .toLowerCase();
}

export function filterMlflowModels(
  models: readonly unknown[],
  options: MlflowSearchMatchOptions,
): unknown[] {
  const needle = options.query.toLowerCase();
  const cap = options.limit ?? 50;
  const out: unknown[] = [];
  for (const it of models) {
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
