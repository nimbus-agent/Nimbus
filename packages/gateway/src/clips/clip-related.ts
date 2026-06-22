export interface RelatedInput {
  readonly title?: string;
  readonly canonicalUrl?: string;
  readonly selection?: string;
  readonly limit?: number;
}

export interface RelatedHit {
  readonly id: string;
  readonly title: string;
  readonly service: string;
  readonly snippet: string;
  readonly url: string | null;
}

export interface ClipRelatedDeps {
  /** Injected hybrid-search adapter (text query + limit → ranked hits). */
  readonly search: (query: string, limit: number) => Promise<RelatedHit[]>;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

function hostOf(url: string | null | undefined): string | undefined {
  if (url === null || url === undefined) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

export function buildRelatedQuery(input: RelatedInput): { query: string; excludeHost?: string } {
  const query = (input.selection ?? input.title ?? "").trim();
  const excludeHost = hostOf(input.canonicalUrl);
  return excludeHost === undefined ? { query } : { query, excludeHost };
}

export async function runClipRelated(
  deps: ClipRelatedDeps,
  input: RelatedInput,
): Promise<{ items: RelatedHit[] }> {
  const { query, excludeHost } = buildRelatedQuery(input);
  if (query === "") return { items: [] };
  const limit = Math.min(MAX_LIMIT, Math.max(1, input.limit ?? DEFAULT_LIMIT));
  const hits = await deps.search(query, limit);
  const items =
    excludeHost === undefined ? hits : hits.filter((h) => hostOf(h.url) !== excludeHost);
  return { items };
}
