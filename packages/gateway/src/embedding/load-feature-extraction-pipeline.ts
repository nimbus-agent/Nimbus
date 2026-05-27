/**
 * Thin boundary around `@xenova/transformers`. This is the ONLY module that
 * touches the dynamic import + onnxruntime-node native addon, so it is
 * structurally excluded from the coverage floor (same rationale as
 * embedding-worker.ts). Keeping the import here lets `model.ts` be unit-tested
 * by mocking this module's path — and crucially a DIFFERENT path from
 * `model.ts` itself, which `create-routing-runtime.test.ts` mocks
 * process-globally.
 */

/** Callable returned by a "feature-extraction" pipeline. */
export type FeatureExtractionPipe = (
  texts: string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array; dims: readonly number[] }>;

const XENOVA_MODEL_REPO = "Xenova/all-MiniLM-L6-v2";

/** Load the MiniLM feature-extraction pipeline, caching weights under `cacheDir`. */
export async function loadFeatureExtractionPipeline(
  cacheDir: string,
): Promise<FeatureExtractionPipe> {
  const { env, pipeline } = await import("@xenova/transformers");
  env.cacheDir = cacheDir;
  return (await pipeline(
    "feature-extraction",
    XENOVA_MODEL_REPO,
  )) as unknown as FeatureExtractionPipe;
}
