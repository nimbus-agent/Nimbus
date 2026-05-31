import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLocalEmbedder } from "../../embedding/model.ts";
import type { Embedder } from "../../embedding/types.ts";
import { synthesizeText } from "../fixtures/synthetic-text.ts";
import type { CorpusTier, S8Batch, S8Length } from "../types.ts";

export interface EmbeddingThroughputOptions {
  length: S8Length;
  batch: S8Batch;
  totalItems?: number;
  corpus?: CorpusTier;
  embedder?: Embedder;
  cacheDir?: string;
}

const DEFAULT_BATCH_MULTIPLIER = 1_000;

const CORPUS_BATCH_MULTIPLIER: Record<CorpusTier, number> = {
  small: 10,
  medium: 100,
  large: DEFAULT_BATCH_MULTIPLIER,
};

function resolveBatchMultiplier(corpus: CorpusTier | undefined): number {
  return corpus === undefined ? DEFAULT_BATCH_MULTIPLIER : CORPUS_BATCH_MULTIPLIER[corpus];
}

async function getEmbedder(opts: EmbeddingThroughputOptions): Promise<Embedder> {
  if (opts.embedder !== undefined) return opts.embedder;
  return createLocalEmbedder({
    cacheDir: opts.cacheDir ?? join(tmpdir(), "nimbus-bench-models"),
  });
}

export async function runEmbeddingThroughputOnce(
  opts: EmbeddingThroughputOptions,
): Promise<number[]> {
  const totalItems = opts.totalItems ?? opts.batch * resolveBatchMultiplier(opts.corpus);
  const texts = synthesizeText({ length: opts.length, count: totalItems });
  const embedder = await getEmbedder(opts);

  await embedder.embed([texts[0] ?? "warm-up"]);

  const t0 = performance.now();
  for (let i = 0; i < texts.length; i += opts.batch) {
    await embedder.embed(texts.slice(i, i + opts.batch));
  }
  const elapsed = performance.now() - t0;
  if (elapsed <= 0) return [0];
  const itemsPerSec = texts.length / (elapsed / 1000);
  return [itemsPerSec];
}
