export interface RelatedInput {
  readonly title?: string;
  readonly canonicalUrl?: string;
  readonly selection?: string;
  /** An indexed item id — the page the caller has already resolved. When it
   *  names a real row, its title becomes the query and the item is dropped from
   *  its own results. */
  readonly itemId?: string;
  readonly limit?: number;
}

export interface RelatedHit {
  readonly id: string;
  readonly title: string;
  readonly service: string;
  /** The connector's item kind — `pr`, `issue`, `ci_run`, … An OPEN vocabulary:
   *  every connector may add one, so consumers must not switch exhaustively. */
  readonly type: string;
  readonly snippet: string;
  readonly url: string | null;
  /** Epoch MILLISECONDS, matching `GET /v1/items/resolve`'s `item.modified_at`. */
  readonly modified_at: number;
}

export interface ClipRelatedDeps {
  /** Injected hybrid-search adapter (text query + limit → ranked hits). */
  readonly search: (query: string, limit: number) => Promise<RelatedHit[]>;
  /** Injected metadata read for `itemId`. Null when the id names no row. */
  readonly lookupItem: (id: string) => { title: string } | null;
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

export function buildRelatedQuery(
  input: RelatedInput,
  lookupItem: (id: string) => { title: string } | null,
): { query: string; excludeHost?: string; excludeId?: string } {
  const o = (input ?? {}) as RelatedInput;
  const itemId = asStr(o.itemId)?.trim();
  // Looked up BEFORE precedence is applied: a selection wins the query text, but
  // the item you are standing on is still the one answer that cannot tell you
  // anything new, so the exclusion is keyed on the id existing — not on it having
  // won. Keeping these two rules independent is the whole point.
  const item = itemId === undefined || itemId === "" ? null : lookupItem(itemId);
  // The item's TITLE, never its body: ftsMatchQuery AND-joins every token, so a
  // 16 KiB body becomes thousands of required terms and matches nothing.
  //
  // `item?.title || undefined`, not a bare `item?.title`: a resolved item whose
  // title is the empty string is non-nullish, so plain `??` chaining would lock
  // the query to `""` and short-circuit to zero results instead of falling
  // through to `o.title` like a genuinely missing/unresolved item does. The `||`
  // here (not `??`) is what turns that empty string back into a nullish value so
  // the `??` chain below can fall through it.
  const query = (asStr(o.selection) ?? (item?.title || undefined) ?? asStr(o.title) ?? "").trim();
  const excludeHost = hostOf(asStr(o.canonicalUrl));
  return {
    query,
    ...(excludeHost === undefined ? {} : { excludeHost }),
    ...(item === null || itemId === undefined ? {} : { excludeId: itemId }),
  };
}

export async function runClipRelated(
  deps: ClipRelatedDeps,
  input: RelatedInput,
): Promise<{ items: RelatedHit[] }> {
  const { query, excludeHost, excludeId } = buildRelatedQuery(input, deps.lookupItem);
  if (query === "") return { items: [] };
  const rawLimit =
    typeof input?.limit === "number" && Number.isFinite(input.limit) ? input.limit : DEFAULT_LIMIT;
  const limit = Math.min(MAX_LIMIT, Math.max(1, rawLimit));
  const hits = await deps.search(query, limit);
  const items = hits.filter(
    (h) =>
      (excludeHost === undefined || hostOf(h.url) !== excludeHost) &&
      (excludeId === undefined || h.id !== excludeId),
  );
  return { items };
}
