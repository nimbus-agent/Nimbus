import { MAX_INDEX_HITS, MAX_REF_TITLE_CHARS, MAX_REF_URL_CHARS } from "./brief-constants.ts";
import type { BriefRun, SourceRegistry, SourceRegistryEntry } from "./brief-types.ts";

export type IndexHit = {
  readonly itemId: string;
  readonly title: string;
  readonly url: string | null;
  readonly snippet: string;
};

/**
 * Injected index search. Returns `semanticAvailable: false` when the hybrid
 * path was unavailable and the result came from BM25 only — the caller turns
 * that into a gap so "we could not search properly" is never mistaken for
 * "your index had nothing relevant".
 */
export type IndexSearch = (
  query: string,
  limit: number,
) => Promise<{ hits: IndexHit[]; semanticAvailable: boolean }>;

function clipTitle(title: string): string {
  return title.slice(0, MAX_REF_TITLE_CHARS);
}

function clipUrl(url: string): string {
  return url.slice(0, MAX_REF_URL_CHARS);
}

/**
 * Builds the set of sources the model is allowed to cite. Tokens are opaque and
 * server-issued (S1.. for fed sources, C1.. for indexed clips): the model never
 * authors a URL or a title, so it cannot invent a source that resolves.
 */
export async function buildRegistry(
  run: BriefRun,
  search: IndexSearch | null,
): Promise<{
  registry: SourceRegistry;
  indexHits: number;
  semanticAvailable: boolean;
  searchFailed: boolean;
}> {
  const registry = new Map<string, SourceRegistryEntry>();

  let n = 0;
  for (const source of run.sources.values()) {
    n += 1;
    const token = `S${n}`;
    registry.set(token, {
      token,
      ref: { kind: "source", title: clipTitle(source.title), url: clipUrl(source.url) },
      body: source.body,
    });
  }

  if (!run.useIndex || search === null) {
    return { registry, indexHits: 0, semanticAvailable: true, searchFailed: false };
  }

  let hits: IndexHit[] = [];
  let semanticAvailable = true;
  try {
    const out = await search(run.brief, MAX_INDEX_HITS);
    hits = out.hits.slice(0, MAX_INDEX_HITS);
    semanticAvailable = out.semanticAvailable;
  } catch {
    // A broken index must not cost the user their sweep — degrade to sources only. But
    // report it as a FAILURE, not as an empty result: claiming "nothing matched" when the
    // search never ran is exactly the dishonesty brief-gaps.ts exists to prevent.
    return { registry, indexHits: 0, semanticAvailable: true, searchFailed: true };
  }

  let m = 0;
  for (const hit of hits) {
    m += 1;
    const token = `C${m}`;
    registry.set(token, {
      token,
      ref: {
        kind: "clip",
        title: clipTitle(hit.title),
        clipId: hit.itemId,
        ...(hit.url === null ? {} : { url: clipUrl(hit.url) }),
      },
      body: hit.snippet,
    });
  }

  return { registry, indexHits: hits.length, semanticAvailable, searchFailed: false };
}
