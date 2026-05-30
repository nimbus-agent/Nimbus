export interface SearchMatchOptions {
  readonly query: string;
  readonly limit?: number | undefined;
}

export interface FilterByQueryOptions<T> {
  readonly query: string;
  readonly limit?: number | undefined;
  readonly fields: (item: T) => readonly (string | null | undefined)[] | null;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function asObjectish(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function stringField(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : "";
}

export function tagText(row: Record<string, unknown>): string {
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

export function filterByQuery<T>(items: readonly T[], options: FilterByQueryOptions<T>): T[] {
  const needle = options.query.toLowerCase();
  const cap = options.limit ?? 50;
  const out: T[] = [];
  for (const item of items) {
    const parts = options.fields(item);
    if (parts === null) {
      continue;
    }
    const haystack = parts.join(" ").toLowerCase();
    if (!haystack.includes(needle)) {
      continue;
    }
    out.push(item);
    if (out.length >= cap) {
      break;
    }
  }
  return out;
}

export type FieldExtractor = (item: unknown) => readonly (string | null | undefined)[] | null;

/**
 * Build a {@link FieldExtractor} that reads a fixed list of string keys off each
 * objectish row, optionally appending the standard `tags` text. Collapses the
 * boilerplate `fieldsOf` body shared by the simpler connectors.
 */
export function fieldsFromKeys(
  keys: readonly string[],
  opts?: { readonly tags?: boolean },
): FieldExtractor {
  return (item: unknown) => {
    const row = asObjectish(item);
    if (row === undefined) {
      return null;
    }
    const parts = keys.map((key) => stringField(row, key));
    if (opts?.tags === true) {
      parts.push(tagText(row));
    }
    return parts;
  };
}

/**
 * Build a `filter<Thing>(items, options)` search function from a field
 * extractor. Connectors with bespoke extraction pass their own `fieldsOf`;
 * simple ones pair this with {@link fieldsFromKeys}.
 */
export function makeQueryFilter(
  fields: FieldExtractor,
): (items: readonly unknown[], options: SearchMatchOptions) => unknown[] {
  return (items, options) => filterByQuery(items, { ...options, fields });
}
