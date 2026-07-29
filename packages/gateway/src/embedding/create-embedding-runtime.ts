import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { Logger } from "pino";

import type { NimbusEmbeddingToml } from "../config/nimbus-toml.ts";
import { readIndexedUserVersion } from "../index/migrations/runner.ts";
import { processEnvGet } from "../platform/env-access.ts";
import type { PlatformPaths } from "../platform/paths.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { tryCreateRoutingEmbeddingRuntime } from "./create-routing-runtime.ts";
import { createDeferredEmbeddingRuntime } from "./deferred-runtime.ts";
import type { EmbeddingRuntime } from "./embedding-runtime.ts";
import { createLazyEmbeddingRuntime } from "./lazy-scheduler.ts";
import { LOCAL_EMBEDDING_MODEL_ID } from "./model.ts";
import { type CreateOpenAIEmbedderOptions, createOpenAIEmbedder } from "./openai-embedder.ts";
import type { Embedder } from "./types.ts";
import { tryCreateEmbeddingWorkerBridge } from "./worker-bridge.ts";

type OpenAIEmbedderFactory = (options: CreateOpenAIEmbedderOptions) => Promise<Embedder>;

type RoutingRuntimeFactory = (
  db: Database,
  paths: PlatformPaths,
  logger: Logger,
  slice: { chunkTokens: number; chunkOverlapTokens: number; backfillBatchSize: number },
  vault: NimbusVault,
) => Promise<EmbeddingRuntime | null>;

type WorkerBridgeFactory = (
  dbPath: string,
  dataDir: string,
  slice: { chunkTokens: number; chunkOverlapTokens: number; backfillBatchSize: number },
  logger: Logger,
) => EmbeddingRuntime | null;

/** Optional DI overrides – pass only in tests. */
export type EmbeddingRuntimeOverrides = {
  openaiEmbedderFactory?: OpenAIEmbedderFactory;
  routingRuntimeFactory?: RoutingRuntimeFactory;
  workerBridgeFactory?: WorkerBridgeFactory;
};

async function tryCreateOpenAIEmbeddingRuntime(
  db: Database,
  paths: PlatformPaths,
  logger: Logger,
  slice: {
    chunkTokens: number;
    chunkOverlapTokens: number;
    backfillBatchSize: number;
  },
  tomlEmbedding: NimbusEmbeddingToml,
  vault: NimbusVault,
  openaiEmbedderFactory: OpenAIEmbedderFactory = createOpenAIEmbedder,
): Promise<EmbeddingRuntime | null> {
  let apiKey = processEnvGet("OPENAI_API_KEY")?.trim() ?? "";
  if (apiKey === "") {
    const v = await vault.get("openai.api_key");
    apiKey = typeof v === "string" ? v.trim() : "";
  }
  if (apiKey === "") {
    logger.warn("OpenAI embedding: set OPENAI_API_KEY or vault key openai.api_key");
    return null;
  }
  let openaiModel = tomlEmbedding.model.trim();
  if (
    openaiModel === "" ||
    openaiModel.includes("MiniLM") ||
    openaiModel.toLowerCase().includes("xenova")
  ) {
    openaiModel = "text-embedding-3-small";
  }
  try {
    const embedder = await openaiEmbedderFactory({
      apiKey,
      model: openaiModel,
      dimensions: 1536,
    });
    return createLazyEmbeddingRuntime(db, paths.dataDir, logger, slice, embedder);
  } catch (err) {
    logger.warn(
      {
        errName: err instanceof Error ? err.name : "Error",
        errMessage: err instanceof Error ? err.message : String(err),
      },
      "OpenAI embedder init failed",
    );
    return null;
  }
}

/**
 * The three CHEAP, synchronous reasons there is no embedding runtime at all: env kill-switch,
 * config/env disable, or a schema that predates semantic memory. Split out so the bind-first
 * factory can answer "runtime or no runtime" without touching the network (#928).
 */
export function embeddingRuntimeWanted(
  db: Database,
  tomlEmbedding: NimbusEmbeddingToml,
  envAllowsEmbeddings: boolean,
): boolean {
  if (processEnvGet("NIMBUS_SKIP_EMBEDDING_RUNTIME") === "1") {
    return false;
  }
  if (!envAllowsEmbeddings || !tomlEmbedding.enabled) {
    return false;
  }
  return readIndexedUserVersion(db) >= 6;
}

/**
 * Bind-first entry point (#928): returns SYNCHRONOUSLY so gateway assembly can reach
 * `ipc.start()` without waiting on a model fetch. `null` still means "no embeddings at all
 * in this process" — decided from the cheap synchronous checks only. Everything slow
 * (`createEmbeddingRuntime`) runs behind the deferred wrapper, which reports warm-up state
 * and refuses to hand back a null vector while warming.
 */
export function createEmbeddingRuntimeNonBlocking(
  db: Database,
  paths: PlatformPaths,
  logger: Logger,
  tomlEmbedding: NimbusEmbeddingToml,
  envAllowsEmbeddings: boolean,
  vault: NimbusVault,
  overrides?: EmbeddingRuntimeOverrides,
): EmbeddingRuntime | null {
  if (!embeddingRuntimeWanted(db, tomlEmbedding, envAllowsEmbeddings)) {
    return null;
  }
  return createDeferredEmbeddingRuntime({
    init: () =>
      createEmbeddingRuntime(
        db,
        paths,
        logger,
        tomlEmbedding,
        envAllowsEmbeddings,
        vault,
        overrides,
      ),
    fallbackModel: LOCAL_EMBEDDING_MODEL_ID,
    fallbackDims: 384,
    onStateChange: (readiness) => {
      logger.info(
        { msg: "embedding_readiness", state: readiness.state, reason: readiness.reason },
        `embedding runtime: ${readiness.state}`,
      );
    },
  });
}

export async function createEmbeddingRuntime(
  db: Database,
  paths: PlatformPaths,
  logger: Logger,
  tomlEmbedding: NimbusEmbeddingToml,
  envAllowsEmbeddings: boolean,
  vault: NimbusVault,
  overrides?: EmbeddingRuntimeOverrides,
): Promise<EmbeddingRuntime | null> {
  if (!embeddingRuntimeWanted(db, tomlEmbedding, envAllowsEmbeddings)) {
    return null;
  }

  const slice = {
    chunkTokens: tomlEmbedding.chunkTokens,
    chunkOverlapTokens: tomlEmbedding.chunkOverlapTokens,
    backfillBatchSize: tomlEmbedding.backfillBatchSize,
  };

  const routingFactory = overrides?.["routingRuntimeFactory"] ?? tryCreateRoutingEmbeddingRuntime;
  const workerFactory = overrides?.["workerBridgeFactory"] ?? tryCreateEmbeddingWorkerBridge;
  const openaiFactory = overrides?.["openaiEmbedderFactory"] ?? createOpenAIEmbedder;

  if (tomlEmbedding.provider === "hybrid") {
    const hybrid = await routingFactory(db, paths, logger, slice, vault);
    if (hybrid !== null) {
      return hybrid;
    }
    // Fall through to the local path below if hybrid setup failed.
  } else if (tomlEmbedding.provider === "openai") {
    return tryCreateOpenAIEmbeddingRuntime(
      db,
      paths,
      logger,
      slice,
      tomlEmbedding,
      vault,
      openaiFactory,
    );
  }

  const dbPath = join(paths.dataDir, "nimbus.db");
  const worker = workerFactory(dbPath, paths.dataDir, slice, logger);
  if (worker !== null) {
    return worker;
  }
  return createLazyEmbeddingRuntime(db, paths.dataDir, logger, slice);
}
