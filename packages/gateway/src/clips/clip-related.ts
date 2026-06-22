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

/** Coerce an untrusted field to a string, or undefined when it isn't one (req.json() is unknown). */
function asStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function buildRelatedQuery(input: RelatedInput): { query: string; excludeHost?: string } {
  // `input` arrives from req.json() — fields may be any type; coerce defensively so a non-string
  // title/selection can't throw (TypeError → 500) at `.trim()`.
  const o = (input ?? {}) as RelatedInput;
  const query = (asStr(o.selection) ?? asStr(o.title) ?? "").trim();
  const excludeHost = hostOf(asStr(o.canonicalUrl));
  return excludeHost === undefined ? { query } : { query, excludeHost };
}

export async function runClipRelated(
  deps: ClipRelatedDeps,
  input: RelatedInput,
): Promise<{ items: RelatedHit[] }> {
  const { query, excludeHost } = buildRelatedQuery(input);
  if (query === "") return { items: [] };
  const rawLimit =
    typeof input?.limit === "number" && Number.isFinite(input.limit) ? input.limit : DEFAULT_LIMIT;
  const limit = Math.min(MAX_LIMIT, Math.max(1, rawLimit));
  const hits = await deps.search(query, limit);
  const items =
    excludeHost === undefined ? hits : hits.filter((h) => hostOf(h.url) !== excludeHost);
  return { items };
}
