import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { Logger } from "pino";

import type { NimbusEmbeddingToml } from "../config/nimbus-toml.ts";
import { wrapLedgeredEmbedder } from "../egress/embedding-egress.ts";
import { readIndexedUserVersion } from "../index/migrations/runner.ts";
import { ensureSqliteVecForConnection } from "../index/sqlite-vec-load.ts";
import { processEnvGet } from "../platform/env-access.ts";
import type { PlatformPaths } from "../platform/paths.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import type { BackfillGate } from "./backfill-gate.ts";
import type { EmbeddingReadiness } from "./embedding-readiness.ts";
import type { EmbeddingRuntime } from "./embedding-runtime.ts";
import { type CreateLocalEmbedderOptions, createLocalEmbedder } from "./model.ts";
import { createOpenAIEmbedder } from "./openai-embedder.ts";
import { SqliteEmbeddingPipeline } from "./pipeline.ts";
import { EMBEDDING_DIM_LOCAL, EMBEDDING_DIM_OPENAI } from "./routing.ts";
import { RoutingEmbeddingPipeline } from "./routing-pipeline.ts";
import type { Embedder, IndexedItem } from "./types.ts";

async function resolveOpenAIApiKey(vault: NimbusVault): Promise<string> {
  const envKey = processEnvGet("OPENAI_API_KEY")?.trim() ?? "";
  if (envKey !== "") {
    return envKey;
  }
  const v = await vault.get("openai.api_key");
  return typeof v === "string" ? v.trim() : "";
}

/**
 * The seams and the one piece of production wiring this factory takes beyond its five required
 * arguments. One bag rather than three trailing positionals: a caller that wanted only the LAST of
 * them had to spell `undefined, undefined, { backfillGate }`, which is both unreadable and a place
 * for an argument to quietly stop travelling.
 */
export type RoutingRuntimeDeps = {
  /** Test seam. */
  createEmbedder?: ((options: CreateLocalEmbedderOptions) => Promise<Embedder>) | undefined;
  /** Test seam. */
  checkVec?: ((db: Database, uv: number) => boolean) | undefined;
  /** Production wiring: `[embedding] pause_on_battery`'s consumer, built by `assemble.ts`. */
  backfillGate?: BackfillGate | undefined;
};

export async function tryCreateRoutingEmbeddingRuntime(
  db: Database,
  paths: PlatformPaths,
  logger: Logger,
  toml: Pick<NimbusEmbeddingToml, "chunkTokens" | "chunkOverlapTokens" | "backfillBatchSize">,
  vault: NimbusVault,
  deps: RoutingRuntimeDeps = {},
): Promise<EmbeddingRuntime | null> {
  const createEmbedder = deps.createEmbedder ?? createLocalEmbedder;
  const checkVec = deps.checkVec ?? ensureSqliteVecForConnection;
  const apiKey = await resolveOpenAIApiKey(vault);
  if (apiKey === "") {
    logger.warn("Hybrid embedding: openai.api_key missing; routing falls back to MiniLM-only");
    return null;
  }

  let localEmbedder: Embedder;
  let openaiEmbedder: Embedder;
  try {
    localEmbedder = await createEmbedder({ cacheDir: join(paths.dataDir, "models") });
    openaiEmbedder = wrapLedgeredEmbedder(
      db,
      await createOpenAIEmbedder({
        apiKey,
        model: "text-embedding-3-small",
        dimensions: EMBEDDING_DIM_OPENAI,
      }),
    );
  } catch (err) {
    logger.warn(
      {
        errName: err instanceof Error ? err.name : "Error",
        errMessage: err instanceof Error ? err.message : String(err),
      },
      "Hybrid embedding init failed",
    );
    return null;
  }

  const uv = readIndexedUserVersion(db);
  if (!checkVec(db, uv)) {
    logger.warn("sqlite-vec unavailable; hybrid mode falls back to MiniLM-only");
    return null;
  }

  // `[embedding] pause_on_battery`, wrapped so `terminate()` ends a PAUSED poll loop — same shape
  // and same reason as `lazy-scheduler.ts`. BOTH pipelines get it: the hybrid backfill walks the
  // OpenAI-routed keys first and the MiniLM-routed keys second, so gating only one would leave
  // half of a hybrid install's backfill running on battery.
  let stopped = false;
  const outerGate = deps.backfillGate;
  const backfillGate: BackfillGate | undefined =
    outerGate === undefined ? undefined : async () => (stopped ? false : outerGate());
  const gateOpt = backfillGate === undefined ? {} : { backfillGate };

  const local = new SqliteEmbeddingPipeline({
    db,
    embedder: localEmbedder,
    ...gateOpt,
    backfillBatchSize: toml.backfillBatchSize,
    chunkOptions: {
      maxChunkTokens: toml.chunkTokens,
      overlapTokens: toml.chunkOverlapTokens,
    },
    logger,
  });
  const openai = new SqliteEmbeddingPipeline({
    db,
    embedder: openaiEmbedder,
    ...gateOpt,
    backfillBatchSize: toml.backfillBatchSize,
    chunkOptions: {
      maxChunkTokens: toml.chunkTokens,
      overlapTokens: toml.chunkOverlapTokens,
    },
    logger,
  });
  const pipeline = new RoutingEmbeddingPipeline(db, local, openai);

  let backfillStarted = false;

  return {
    scheduleItemEmbedding(itemId: string): void {
      void (async () => {
        const row = db
          .query(`SELECT id, service, type, title, body_preview FROM item WHERE id = ?`)
          .get(itemId) as IndexedItem | null | undefined;
        if (row === null || row === undefined) {
          return;
        }
        await pipeline.embedItem(row);
      })().catch((err: unknown) => {
        logger.warn({ err, itemId }, "embedding item failed");
      });
    },

    async embedQuery(text: string): Promise<Float32Array | null> {
      const vecs = await localEmbedder.embed([text]);
      return vecs[0] ?? null;
    },

    async embedQueryDual(text: string): Promise<{
      vec384: Float32Array | null;
      vec1536: Float32Array | null;
      model384: string | null;
      model1536: string | null;
    }> {
      const [local384, openai1536] = await Promise.all([
        localEmbedder.embed([text]),
        openaiEmbedder.embed([text]),
      ]);
      return {
        vec384: local384[0] ?? null,
        vec1536: openai1536[0] ?? null,
        model384: localEmbedder.model,
        model1536: openaiEmbedder.model,
      };
    },

    getEmbeddingModel(): string {
      return localEmbedder.model;
    },

    getEmbeddingDims(): number {
      return EMBEDDING_DIM_LOCAL;
    },

    getBackfillProgress(): { done: number; total: number } | null {
      return null;
    },

    // This runtime is only ever CONSTRUCTED after both embedders resolved, so it is ready
    // by construction — the slow part happened above, off the gateway's bind path (#928).
    getReadiness(): EmbeddingReadiness {
      return {
        state: "ready",
        elapsedMs: 0,
        model: localEmbedder.model,
        dims: EMBEDDING_DIM_LOCAL,
        download: null,
        reason: null,
      };
    },

    startBackgroundJobs(): void {
      if (backfillStarted) {
        return;
      }
      backfillStarted = true;
      void pipeline.backfillAll().catch((err: unknown) => {
        logger.warn({ err }, "hybrid embedding backfill failed");
      });
    },

    terminate(): void {
      // Stops the backfill at its NEXT gate check, not mid-sleep — see `lazy-scheduler.ts`'s
      // `terminate` for the bound. The shared gate's own `stop()` is what ends a pause in progress.
      stopped = true;
    },
  };
}
