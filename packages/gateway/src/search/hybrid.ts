import type { Database } from "bun:sqlite";
import {
  dedupeHybridByCanonicalUrl,
  ftsMatchQuery,
  loadBm25Hits,
  runVectorSearch,
  scoreHybridItems,
} from "./hybrid-internal.ts";
import type { HybridSearchOptions, HybridSearchResult } from "./hybrid-types.ts";

export async function hybridSearch(
  db: Database,
  opts: HybridSearchOptions,
): Promise<HybridSearchResult[]> {
  const nameQ = opts.query.trim();
  const k = opts.rrfK ?? 60;
  const wB = opts.bm25Weight ?? 0.6;
  const wV = opts.vectorWeight ?? 0.4;
  const limit = Math.min(500, Math.max(1, Math.floor(opts.limit)));
  const contextN = Math.min(8, Math.max(0, Math.floor(opts.contextChunks ?? 2)));

  let serviceFilter: string | undefined;
  if (opts.service !== undefined && opts.service !== "") {
    serviceFilter = opts.service;
  }

  const fts = ftsMatchQuery(nameQ);
  const useFts = nameQ.length > 0 && fts !== "";

  const bm25Hits = useFts ? loadBm25Hits(db, fts, limit, serviceFilter, opts) : [];
  const vecHitsRaw = runVectorSearch(db, opts, limit, serviceFilter, nameQ);
  const scored = scoreHybridItems(bm25Hits, vecHitsRaw, {
    db,
    opts,
    k,
    wB,
    wV,
    contextN,
  });
  const deduped = dedupeHybridByCanonicalUrl(scored);
  return deduped.slice(0, limit);
}
