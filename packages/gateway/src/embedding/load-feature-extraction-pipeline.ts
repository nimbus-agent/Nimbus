export type FeatureExtractionPipe = (
  texts: string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array; dims: readonly number[] }>;

const XENOVA_MODEL_REPO = "Xenova/all-MiniLM-L6-v2";

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
