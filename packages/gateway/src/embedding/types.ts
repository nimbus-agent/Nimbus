export type IndexedItem = {
  id: string;
  service: string;
  type: string;
  title: string;
  body_preview: string | null;
};

export type Chunk = {
  itemId: string;
  chunkIndex: number;
  text: string;
};

export interface Embedder {
  model: string;
  dims: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

/** Result shape of the dual-dimension query embedding (384 local / 1536 OpenAI). */
export type EmbeddingDualVectors = {
  vec384: Float32Array | null;
  vec1536: Float32Array | null;
  model384: string | null;
  model1536: string | null;
};

export interface EmbeddingPipeline {
  embedItem(item: IndexedItem): Promise<void>;
  deleteItemEmbeddings(itemId: string): Promise<void>;
  backfillAll(onProgress?: (done: number, total: number) => void): Promise<void>;
}
