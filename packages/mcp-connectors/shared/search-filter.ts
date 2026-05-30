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
