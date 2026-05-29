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

function searchOneTable(
  db: Database,
  opts: DualSearchOptions,
  queryEmbedding: Float32Array | undefined,
  model: string | undefined,
): VectorChunkHit[] {
  if (queryEmbedding === undefined || model === undefined) return [];
  return vectorSearchChunks(db, {
    queryEmbedding,
    model,
    limit: opts.limit,
    ...(opts.service !== undefined ? { service: opts.service } : {}),
    ...(opts.itemType !== undefined ? { itemType: opts.itemType } : {}),
    ...(opts.since !== undefined ? { since: opts.since } : {}),
  });
}

export function vectorSearchChunksDual(db: Database, opts: DualSearchOptions): VectorChunkHit[] {
  const hits: VectorChunkHit[] = [
    ...searchOneTable(db, opts, opts.queryEmbedding384, opts.model384),
    ...searchOneTable(db, opts, opts.queryEmbedding1536, opts.model1536),
  ];
  hits.sort((a, b) => a.distance - b.distance);
  return hits.slice(0, opts.limit);
}
