// Type-only module: NO executable runtime logic. It is exact-path-excluded from the coverage floor
// in scripts/coverage-floor/exclusions.ts (a type-only file emits no SF: lcov record). Adding runtime
// logic here would silently bypass the floor — put runtime logic in a separate, covered module.
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
