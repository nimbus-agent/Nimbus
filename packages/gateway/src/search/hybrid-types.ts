export type HybridIndexedItem = {
  id: string;
  service: string;
  type: string;
  external_id: string;
  title: string;
  body_preview: string | null;
  url: string | null;
  canonical_url: string | null;
  modified_at: number;
  author_id: string | null;
  metadata: string | null;
  synced_at: number;
  pinned: number;
};

export type HybridSearchOptions = {
  query: string;
  limit: number;
  service?: string;
  itemType?: string;
  since?: number;
  semantic?: boolean;
  bm25Weight?: number;
  vectorWeight?: number;
  rrfK?: number;
  embeddingModel: string;
  queryEmbedding?: Float32Array;
  queryEmbedding1536?: Float32Array;
  embeddingModel1536?: string;
  contextChunks?: number;
};

export type HybridSearchResult = {
  item: HybridIndexedItem;
  bm25Rank: number | null;
  vectorRank: number | null;
  rrfScore: number;
  duplicates?: readonly string[];
  semanticSnippet?: string;
};
