// NOTE: this module is coverage-floor-excluded (a real-subprocess shell with no seam), so it
// must stay wiring-only. The narrowing of @xenova's progress event lives in the COVERED
// `embedding-readiness.ts` — putting it here would silently bypass the floor.
import { type EmbeddingModelDownload, normalizeModelProgress } from "./embedding-readiness.ts";

export type FeatureExtractionPipe = (
  texts: string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array; dims: readonly number[] }>;

const XENOVA_MODEL_REPO = "Xenova/all-MiniLM-L6-v2";

export async function loadFeatureExtractionPipeline(
  cacheDir: string,
  onProgress?: (progress: EmbeddingModelDownload) => void,
): Promise<FeatureExtractionPipe> {
  const { env, pipeline } = await import("@xenova/transformers");
  env.cacheDir = cacheDir;
  const options =
    onProgress === undefined
      ? undefined
      : {
          progress_callback: (raw: unknown): void => {
            const p = normalizeModelProgress(raw);
            if (p !== null) {
              onProgress(p);
            }
          },
        };
  const pipe = await pipeline("feature-extraction", XENOVA_MODEL_REPO, options);
  // The `as unknown as` bridges @xenova's FeatureExtractionPipeline to the local FeatureExtractionPipe interface.
  return pipe as unknown as FeatureExtractionPipe; // NOSONAR S4325: required cross-library type bridge
}
