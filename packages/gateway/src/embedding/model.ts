import { processEnvGet } from "../platform/env-access.ts";
import type { EmbeddingModelDownload } from "./embedding-readiness.ts";
import {
  type FeatureExtractionPipe,
  loadFeatureExtractionPipeline,
} from "./load-feature-extraction-pipeline.ts";
import type { Embedder } from "./types.ts";

export const MINIMUM_MODEL_VERSION = "1.0.0" as const;

export const LOCAL_EMBEDDING_MODEL_ID = "all-MiniLM-L6-v2" as const;

export type CreateLocalEmbedderOptions = {
  cacheDir: string;
  /** Model-download progress, so a warming gateway can report real progress (#928). */
  onProgress?: (progress: EmbeddingModelDownload) => void;
};

function tensorToRowVectors(tensor: {
  data: Float32Array;
  dims: readonly number[];
}): Float32Array[] {
  const dims = tensor.dims;
  if (dims.length < 2) {
    throw new Error("Unexpected embedding tensor rank");
  }
  const batch = dims[0] ?? 0;
  const width = dims[1] ?? 0;
  const out: Float32Array[] = [];
  for (let i = 0; i < batch; i++) {
    const start = i * width;
    out.push(tensor.data.slice(start, start + width));
  }
  return out;
}

export async function createLocalEmbedder(
  options: CreateLocalEmbedderOptions,
  loadPipeline: (
    cacheDir: string,
    onProgress?: (progress: EmbeddingModelDownload) => void,
  ) => Promise<FeatureExtractionPipe> = loadFeatureExtractionPipeline,
): Promise<Embedder> {
  const override = processEnvGet("NIMBUS_EMBEDDING_MODEL_DIR");
  const cacheDir = override !== undefined && override !== "" ? override : options.cacheDir;
  const pipe = await loadPipeline(cacheDir, options.onProgress);

  return {
    model: LOCAL_EMBEDDING_MODEL_ID,
    dims: 384,
    isLocal: true,
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) {
        return [];
      }
      const output = await pipe(texts, { pooling: "mean", normalize: true });
      return tensorToRowVectors(output);
    },
  };
}
