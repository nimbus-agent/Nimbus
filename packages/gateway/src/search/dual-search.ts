import type { Database } from "bun:sqlite";
import { type VectorChunkHit, vectorSearchChunks } from "./vec-store.ts";

export type DualSearchOptions = {
  queryEmbedding384?: Float32Array;
  queryEmbedding1536?: Float32Array;
  model384?: string;
  model1536?: string;
  limit: number;
  service?: string;
  itemType?: string;
  since?: number;
};

export function vectorSearchChunksDual(db: Database, opts: DualSearchOptions): VectorChunkHit[] {
  const hits: VectorChunkHit[] = [];
  if (opts.queryEmbedding384 !== undefined && opts.model384 !== undefined) {
    hits.push(
      ...vectorSearchChunks(db, {
        queryEmbedding: opts.queryEmbedding384,
        model: opts.model384,
        limit: opts.limit,
        ...(opts.service !== undefined ? { service: opts.service } : {}),
        ...(opts.itemType !== undefined ? { itemType: opts.itemType } : {}),
        ...(opts.since !== undefined ? { since: opts.since } : {}),
      }),
    );
  }
  if (opts.queryEmbedding1536 !== undefined && opts.model1536 !== undefined) {
    hits.push(
      ...vectorSearchChunks(db, {
        queryEmbedding: opts.queryEmbedding1536,
        model: opts.model1536,
        limit: opts.limit,
        ...(opts.service !== undefined ? { service: opts.service } : {}),
        ...(opts.itemType !== undefined ? { itemType: opts.itemType } : {}),
        ...(opts.since !== undefined ? { since: opts.since } : {}),
      }),
    );
  }
  hits.sort((a, b) => a.distance - b.distance);
  return hits.slice(0, opts.limit);
}
