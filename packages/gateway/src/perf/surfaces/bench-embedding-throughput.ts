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
  /** DI seam for the memoised model load (tests only; production uses `createLocalEmbedder`). */
  createEmbedder?: (cacheDir: string) => Promise<Embedder>;
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

/**
 * Process-lifetime memo of the MiniLM load, keyed by cache dir.
 *
 * All 12 S8 cells (l{50|500|5000} × b{1|8|32|64}) resolve the same weights from
 * the same directory, so the load belongs to the process, not to the cell. The
 * REJECTED promise is cached deliberately: when the weights are absent AND
 * huggingface.co is unreachable, `@xenova/transformers` burns ~6m45s before
 * giving up, and re-paying that per cell is ~81 min — which is what cancelled
 * the 45-minute `Bench (ubuntu-24.04)` leg of run 30300911723. Caching the
 * failure turns 12 hangs into one, so the leg still finishes and reports the
 * remaining surfaces. Warm weights (see the model cache in `_perf.yml`) make
 * the failure path unreachable in steady state.
 */
const embedderByCacheDir = new Map<string, Promise<Embedder>>();

/** Drops the memo so tests don't leak a loaded (or failed) embedder into each other. */
export function resetEmbedderCacheForTest(): void {
  embedderByCacheDir.clear();
}

function getEmbedder(opts: EmbeddingThroughputOptions): Promise<Embedder> {
  if (opts.embedder !== undefined) return Promise.resolve(opts.embedder);
  const cacheDir = opts.cacheDir ?? join(tmpdir(), "nimbus-bench-models");
  const memoised = embedderByCacheDir.get(cacheDir);
  if (memoised !== undefined) return memoised;
  const create = opts.createEmbedder ?? ((dir: string) => createLocalEmbedder({ cacheDir: dir }));
  const pending = create(cacheDir);
  embedderByCacheDir.set(cacheDir, pending);
  return pending;
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
