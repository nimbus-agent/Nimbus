import type { Database } from "bun:sqlite";
import type { EmbeddingDualVectors } from "../embedding/types.ts";
import type { HybridSearchOptions } from "../search/hybrid-types.ts";
import { buildAtClause } from "./item-history-at.ts";

/**
 * The options of one hybrid (keyword + vector) search, built from the caller's query and the query's
 * embeddings. Moved out of `LocalIndex.searchRankedAsync` unchanged: an empty service or type filters
 * nothing, and a vector half is set only when its embedding came back.
 */
export function buildHybridSearchOptions(
  db: Database,
  query: {
    readonly service?: string;
    readonly itemType?: string;
    readonly limit?: number;
    readonly atMs?: number;
  },
  base: { readonly query: string; readonly embeddingModel: string; readonly contextChunks: number },
  dual: EmbeddingDualVectors,
): HybridSearchOptions {
  const opts: HybridSearchOptions = {
    query: base.query,
    limit: query.limit ?? 50,
    semantic: true,
    embeddingModel: base.embeddingModel,
    contextChunks: base.contextChunks,
  };
  if (query.service !== undefined && query.service !== "") {
    opts.service = query.service;
  }
  if (query.itemType !== undefined && query.itemType !== "") {
    opts.itemType = query.itemType;
  }
  if (query.atMs !== undefined) {
    opts.at = buildAtClause(db, query.atMs, "i");
  }
  if (dual.vec384 !== null) {
    opts.queryEmbedding = dual.vec384;
  }
  if (dual.vec1536 !== null && dual.model1536 !== null) {
    opts.queryEmbedding1536 = dual.vec1536;
    opts.embeddingModel1536 = dual.model1536;
  }
  return opts;
}
