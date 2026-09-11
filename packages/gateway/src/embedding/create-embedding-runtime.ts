import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { Logger } from "pino";

import type { NimbusEmbeddingToml } from "../config/nimbus-toml.ts";
import { wrapLedgeredEmbedder } from "../egress/embedding-egress.ts";
import { readIndexedUserVersion } from "../index/migrations/runner.ts";
import { processEnvGet } from "../platform/env-access.ts";
import type { PlatformPaths } from "../platform/paths.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import type { BackfillGate } from "./backfill-gate.ts";
import { tryCreateRoutingEmbeddingRuntime } from "./create-routing-runtime.ts";
import { createDeferredEmbeddingRuntime } from "./deferred-runtime.ts";
import type { EmbeddingRuntime } from "./embedding-runtime.ts";
import { createLazyEmbeddingRuntime } from "./lazy-scheduler.ts";
import { LOCAL_EMBEDDING_MODEL_ID } from "./model.ts";
import { type CreateOpenAIEmbedderOptions, createOpenAIEmbedder } from "./openai-embedder.ts";
import type { Embedder } from "./types.ts";
import { tryCreateEmbeddingWorkerBridge } from "./worker-bridge.ts";

type OpenAIEmbedderFactory = (options: CreateOpenAIEmbedderOptions) => Promise<Embedder>;

/**
 * The slice of `[embedding]` every backfill-capable runtime needs. `pauseOnBattery` rides along
 * because the WORKER runtime cannot be handed a gate function (it lives in another realm and
 * builds its own from this flag); the two in-process runtimes take the built gate instead.
 */
type EmbeddingSlice = {
  chunkTokens: number;
  chunkOverlapTokens: number;
  backfillBatchSize: number;
  pauseOnBattery: boolean;
};

/**
 * Both factory seams are `typeof` the real function rather than a hand-written restatement of its
 * shape. A second copy is exactly how an injected fake ends up agreeing with a contract production
 * never sees — and this file has two trailing test-only params (`createEmbedder`, `checkVec`) plus
 * a trailing `opts` to get wrong. A shorter fake stays assignable, so tests are unaffected.
 */
type RoutingRuntimeFactory = typeof tryCreateRoutingEmbeddingRuntime;

type WorkerBridgeFactory = typeof tryCreateEmbeddingWorkerBridge;

/**
 * The third leg's seam, added for the same reason the other two exist: without it the two
 * `createLazyEmbeddingRuntime` call sites below are unobservable, because reaching them for real
 * needs either a MiniLM download or a loaded `sqlite-vec` — so the argument they pass could stop
 * travelling and no test would notice.
 */
type LazyRuntimeFactory = typeof createLazyEmbeddingRuntime;

/** Optional DI overrides – pass only in tests. */
export type EmbeddingRuntimeOverrides = {
  openaiEmbedderFactory?: OpenAIEmbedderFactory;
  routingRuntimeFactory?: RoutingRuntimeFactory;
  workerBridgeFactory?: WorkerBridgeFactory;
  lazyRuntimeFactory?: LazyRuntimeFactory;
};

/**
 * Everything the two public entry points take beyond their six required arguments, in one bag.
 *
 * `overrides` and `backfillGate` are deliberately NOT merged into a single flat object: the first
 * is test-only DI, the second is production wiring `platform/assemble.ts` builds because it owns
 * the teardown for the gate's poll timer. Flattening them would invite a test to pass the gate and
 * production to pass an override.
 */
export type EmbeddingRuntimeDeps = {
  overrides?: EmbeddingRuntimeOverrides | undefined;
  backfillGate?: BackfillGate | undefined;
};

async function tryCreateOpenAIEmbeddingRuntime(
  db: Database,
  paths: PlatformPaths,
  logger: Logger,
  slice: EmbeddingSlice,
  tomlEmbedding: NimbusEmbeddingToml,
  vault: NimbusVault,
  deps: {
    openaiEmbedderFactory?: OpenAIEmbedderFactory | undefined;
    backfillGate?: BackfillGate | undefined;
    lazyFactory?: LazyRuntimeFactory | undefined;
  } = {},
): Promise<EmbeddingRuntime | null> {
  const openaiEmbedderFactory = deps.openaiEmbedderFactory ?? createOpenAIEmbedder;
  const lazyFactory = deps.lazyFactory ?? createLazyEmbeddingRuntime;
  const backfillGate = deps.backfillGate;
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
    const embedder = wrapLedgeredEmbedder(
      db,
      await openaiEmbedderFactory({
        apiKey,
        model: openaiModel,
        dimensions: 1536,
      }),
    );
    return lazyFactory(db, paths.dataDir, logger, slice, embedder, undefined, {
      backfillGate,
    });
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
  deps: EmbeddingRuntimeDeps = {},
): EmbeddingRuntime | null {
  if (!embeddingRuntimeWanted(db, tomlEmbedding, envAllowsEmbeddings)) {
    return null;
  }
  return createDeferredEmbeddingRuntime({
    init: () =>
      createEmbeddingRuntime(db, paths, logger, tomlEmbedding, envAllowsEmbeddings, vault, deps),
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
  deps: EmbeddingRuntimeDeps = {},
): Promise<EmbeddingRuntime | null> {
  if (!embeddingRuntimeWanted(db, tomlEmbedding, envAllowsEmbeddings)) {
    return null;
  }
  const { overrides, backfillGate } = deps;

  const slice: EmbeddingSlice = {
    chunkTokens: tomlEmbedding.chunkTokens,
    chunkOverlapTokens: tomlEmbedding.chunkOverlapTokens,
    backfillBatchSize: tomlEmbedding.backfillBatchSize,
    // Carried for the WORKER leg, which builds its own gate in its own realm.
    pauseOnBattery: tomlEmbedding.pauseOnBattery,
  };

  // `backfillGate` is `[embedding] pause_on_battery`'s consumer, BUILT BY THE CALLER rather than
  // here: it owns a cancellable poll timer, and the only place that can register a teardown for it
  // is `platform/assemble.ts`, which holds `sidecarStops`. `undefined` — every current test, and
  // any embedded use — keeps the old never-pause behaviour rather than silently acquiring a
  // dependency it cannot tear down.

  const routingFactory = overrides?.["routingRuntimeFactory"] ?? tryCreateRoutingEmbeddingRuntime;
  const workerFactory = overrides?.["workerBridgeFactory"] ?? tryCreateEmbeddingWorkerBridge;
  const openaiFactory = overrides?.["openaiEmbedderFactory"] ?? createOpenAIEmbedder;
  const lazyFactory = overrides?.["lazyRuntimeFactory"] ?? createLazyEmbeddingRuntime;

  if (tomlEmbedding.provider === "hybrid") {
    const hybrid = await routingFactory(db, paths, logger, slice, vault, { backfillGate });
    if (hybrid !== null) {
      return hybrid;
    }
    // Fall through to the local path below if hybrid setup failed.
  } else if (tomlEmbedding.provider === "openai") {
    return tryCreateOpenAIEmbeddingRuntime(db, paths, logger, slice, tomlEmbedding, vault, {
      openaiEmbedderFactory: openaiFactory,
      backfillGate,
      lazyFactory,
    });
  }

  const dbPath = join(paths.dataDir, "nimbus.db");
  const worker = workerFactory(dbPath, paths.dataDir, slice, logger);
  if (worker !== null) {
    return worker;
  }
  return lazyFactory(db, paths.dataDir, logger, slice, undefined, undefined, {
    backfillGate,
  });
}
