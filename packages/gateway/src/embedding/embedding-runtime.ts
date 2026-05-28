export type EmbeddingRuntime = {
  scheduleItemEmbedding: (itemId: string) => void;
  embedQuery: (text: string) => Promise<Float32Array | null>;
  embedQueryDual: (text: string) => Promise<{
    vec384: Float32Array | null;
    vec1536: Float32Array | null;
    model384: string | null;
    model1536: string | null;
  }>;
  getEmbeddingModel: () => string;
  getEmbeddingDims: () => number;
  getBackfillProgress: () => { done: number; total: number } | null;
  startBackgroundJobs: () => void;
  terminate: () => void;
};
