import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { Logger } from "pino";

import type { NimbusEmbeddingToml } from "../config/nimbus-toml.ts";
import { readIndexedUserVersion } from "../index/migrations/runner.ts";
import { ensureSqliteVecForConnection } from "../index/sqlite-vec-load.ts";
import type { EmbeddingRuntime } from "./embedding-runtime.ts";
import {
  type CreateLocalEmbedderOptions,
  createLocalEmbedder,
  LOCAL_EMBEDDING_MODEL_ID,
} from "./model.ts";
import { SqliteEmbeddingPipeline } from "./pipeline.ts";
import type { Embedder, IndexedItem } from "./types.ts";

export function createLazyEmbeddingRuntime(
  db: Database,
  dataDir: string,
  logger: Logger,
  toml: Pick<NimbusEmbeddingToml, "chunkTokens" | "chunkOverlapTokens" | "backfillBatchSize">,
  preloadedEmbedder?: Embedder,
  createEmbedder: (options: CreateLocalEmbedderOptions) => Promise<Embedder> = createLocalEmbedder,
): EmbeddingRuntime {
  let pipeline: SqliteEmbeddingPipeline | null = null;
  let loading: Promise<SqliteEmbeddingPipeline | null> | null = null;
  let backfillStarted = false;

  async function ensurePipeline(): Promise<SqliteEmbeddingPipeline | null> {
    const uv = readIndexedUserVersion(db);
    if (uv < 6) {
      return null;
    }
    if (!ensureSqliteVecForConnection(db, uv)) {
      logger.warn("sqlite-vec unavailable; semantic embeddings disabled for this process");
      return null;
    }
    if (pipeline !== null) {
      return pipeline;
    }
    loading ??= (async (): Promise<SqliteEmbeddingPipeline | null> => {
      try {
        const embedder =
          preloadedEmbedder ?? (await createEmbedder({ cacheDir: join(dataDir, "models") }));
        return new SqliteEmbeddingPipeline({
          db,
          embedder,
          logger,
          backfillBatchSize: toml.backfillBatchSize,
          chunkOptions: {
            maxChunkTokens: toml.chunkTokens,
            overlapTokens: toml.chunkOverlapTokens,
          },
        });
      } catch (err) {
        logger.warn({ err }, "failed to initialize local embedding pipeline");
        return null;
      }
    })();
    const resolved = await loading;
    loading = null;
    if (resolved !== null) {
      pipeline = resolved;
    }
    return resolved;
  }

  return {
    scheduleItemEmbedding(itemId: string): void {
      void (async () => {
        const p = await ensurePipeline();
        if (p === null) {
          return;
        }
        const row = db
          .query(`SELECT id, service, type, title, body_preview FROM item WHERE id = ?`)
          .get(itemId) as IndexedItem | null | undefined;
        if (row === null || row === undefined) {
          return;
        }
        await p.embedItem(row);
      })().catch((err: unknown) => {
        logger.warn({ err, itemId }, "embedding item failed");
      });
    },

    async embedQuery(text: string): Promise<Float32Array | null> {
      const p = await ensurePipeline();
      if (p === null) {
        return null;
      }
      const rows = await p.embedTexts([text]);
      return rows[0] ?? null;
    },

    async embedQueryDual(text: string): Promise<{
      vec384: Float32Array | null;
      vec1536: Float32Array | null;
      model384: string | null;
      model1536: string | null;
    }> {
      const p = await ensurePipeline();
      if (p === null) {
        return { vec384: null, vec1536: null, model384: null, model1536: null };
      }
      const vecs = await p.embedTexts([text]);
      const vec = vecs[0] ?? null;
      if (vec === null) {
        return { vec384: null, vec1536: null, model384: null, model1536: null };
      }
      const dims = p.embeddingDims;
      if (dims === 1536) {
        return { vec384: null, vec1536: vec, model384: null, model1536: p.embeddingModel };
      }
      return { vec384: vec, vec1536: null, model384: p.embeddingModel, model1536: null };
    },

    getEmbeddingModel(): string {
      return pipeline?.embeddingModel ?? preloadedEmbedder?.model ?? LOCAL_EMBEDDING_MODEL_ID;
    },

    getEmbeddingDims(): number {
      return pipeline?.embeddingDims ?? preloadedEmbedder?.dims ?? 384;
    },

    getBackfillProgress(): { done: number; total: number } | null {
      return null;
    },

    startBackgroundJobs(): void {
      if (backfillStarted) {
        return;
      }
      backfillStarted = true;
      void ensurePipeline()
        .then(async (p) => {
          if (p === null) {
            return;
          }
          await p.backfillAll().catch((err: unknown) => {
            logger.warn({ err }, "embedding backfill failed");
          });
        })
        .catch((err: unknown) => {
          logger.warn({ err }, "embedding backfill could not start");
        });
    },

    terminate(): void {
      /* in-process: nothing to tear down */
    },
  };
}
