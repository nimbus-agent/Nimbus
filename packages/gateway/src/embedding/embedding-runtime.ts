// Type-only module: NO executable runtime logic. It is exact-path-excluded from the coverage floor
// in scripts/coverage-floor/exclusions.ts (a type-only file emits no SF: lcov record). Adding runtime
// logic here would silently bypass the floor — put runtime logic in a separate, covered module.
import type { EmbeddingReadiness } from "./embedding-readiness.ts";
import type { EmbeddingDualVectors } from "./types.ts";

export type EmbeddingRuntime = {
  scheduleItemEmbedding: (itemId: string) => void;
  /**
   * Resolves `null` only when vectors are permanently unavailable for this process
   * (`disabled` / `unavailable`). While `getReadiness().state === "warming"` an
   * implementation MUST throw `EmbeddingWarmingError` rather than resolve `null` — a
   * null-while-warming is the false green that makes an empty search look legitimate.
   */
  embedQuery: (text: string) => Promise<Float32Array | null>;
  /** Same warming contract as {@link EmbeddingRuntime.embedQuery}. */
  embedQueryDual: (text: string) => Promise<EmbeddingDualVectors>;
  getEmbeddingModel: () => string;
  getEmbeddingDims: () => number;
  getBackfillProgress: () => { done: number; total: number } | null;
  /** Live warm-up/failure state, safe to call at any time and cheap enough to poll. */
  getReadiness: () => EmbeddingReadiness;
  startBackgroundJobs: () => void;
  terminate: () => void;
};
