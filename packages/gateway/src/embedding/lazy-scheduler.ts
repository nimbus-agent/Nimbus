import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { Logger } from "pino";

import type { NimbusEmbeddingToml } from "../config/nimbus-toml.ts";
import { readIndexedUserVersion } from "../index/migrations/runner.ts";
import { ensureSqliteVecForConnection } from "../index/sqlite-vec-load.ts";
import type { BackfillGate } from "./backfill-gate.ts";
import { createBackfillPassTracker } from "./backfill-pass-tracker.ts";
import {
  type EmbeddingModelDownload,
  type EmbeddingReadiness,
  type EmbeddingReadinessState,
  resolveEmbeddingQueryTimeoutMs,
  withEmbeddingQueryTimeout,
} from "./embedding-readiness.ts";
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
  opts?: { backfillGate?: BackfillGate | undefined },
): EmbeddingRuntime {
  let pipeline: SqliteEmbeddingPipeline | null = null;
  // `[embedding] pause_on_battery`. Wrapped rather than passed straight through so `terminate()`
  // ends a PAUSED poll loop: the battery gate itself only ever pauses or proceeds, and a torn-down
  // runtime whose backfill kept re-probing power forever would be a leak with a 30-second heartbeat.
  let stopped = false;
  const outerGate = opts?.backfillGate;
  const backfillGate: BackfillGate | undefined =
    outerGate === undefined ? undefined : async () => (stopped ? false : outerGate());
  let loading: Promise<SqliteEmbeddingPipeline | null> | null = null;
  let backfillStarted = false;
  // Without this, a search during the backfill this runtime runs itself reported no active pass —
  // so partial results read as complete on the in-process runtime (#1535 follow-up).
  const backfillPass = createBackfillPassTracker();
  const startedMs = Date.now();
  let settledMs: number | null = null;
  let state: EmbeddingReadinessState = "warming";
  let reason: string | null = null;
  let download: EmbeddingModelDownload | null = null;

  function settle(next: Exclude<EmbeddingReadinessState, "warming">, why: string | null): void {
    state = next;
    reason = why;
    settledMs ??= Date.now();
    if (next !== "ready") {
      download = null;
    }
  }

  async function ensurePipeline(): Promise<SqliteEmbeddingPipeline | null> {
    const uv = readIndexedUserVersion(db);
    if (uv < 6) {
      settle("disabled", "index schema predates semantic memory (v6)");
      return null;
    }
    if (!ensureSqliteVecForConnection(db, uv)) {
      logger.warn("sqlite-vec unavailable; semantic embeddings disabled for this process");
      settle("unavailable", "sqlite-vec extension is unavailable");
      return null;
    }
    if (pipeline !== null) {
      return pipeline;
    }
    loading ??= (async (): Promise<SqliteEmbeddingPipeline | null> => {
      try {
        const embedder =
          preloadedEmbedder ??
          (await createEmbedder({
            cacheDir: join(dataDir, "models"),
            onProgress: (p) => {
              download = p;
            },
          }));
        return new SqliteEmbeddingPipeline({
          db,
          embedder,
          logger,
          ...(backfillGate === undefined ? {} : { backfillGate }),
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
      settle("ready", null);
    } else {
      settle("unavailable", "local embedding pipeline failed to initialize");
    }
    return resolved;
  }

  // Eager warm-up kickoff (#928). Without it a caller guarded by `getReadiness()` would see
  // `warming` forever — nothing would ever trigger the load — and semantic search would never
  // come up. The work is detached: construction still returns on the same tick.
  void ensurePipeline().catch((err: unknown) => {
    logger.warn({ err }, "embedding warm-up could not start");
    // Never leave the runtime claiming `warming` after a warm-up that can no longer progress —
    // callers would be told "not yet" forever instead of "not going to happen" (#928).
    settle("unavailable", err instanceof Error ? err.message : String(err));
  });

  function readiness(): EmbeddingReadiness {
    const end = state === "warming" ? Date.now() : (settledMs ?? Date.now());
    return {
      state,
      elapsedMs: Math.max(0, end - startedMs),
      model: pipeline?.embeddingModel ?? preloadedEmbedder?.model ?? LOCAL_EMBEDDING_MODEL_ID,
      dims: pipeline?.embeddingDims ?? preloadedEmbedder?.dims ?? 384,
      download: state === "warming" ? download : null,
      reason,
    };
  }

  // Bounds the EMBED only. The pipeline load above it is deliberately outside the budget: a cold
  // model load is warm-up, not a stalled query, and must not be reported as a timeout.
  /**
   * The signal reaches no one here, and that is the honest shape: this runtime's pipeline embeds
   * through a local ONNX inference that cannot be interrupted once started. The timeout still stops
   * the CALLER waiting, which is all it ever did on this path — see `openai-embedder.ts` for the one
   * place cancellation is real.
   */
  function boundQueryEmbed<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return withEmbeddingQueryTimeout(work, {
      timeoutMs: resolveEmbeddingQueryTimeoutMs(),
      readiness,
    });
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
      const rows = await boundQueryEmbed(() => p.embedTexts([text]));
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
      const vecs = await boundQueryEmbed(() => p.embedTexts([text]));
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
      return backfillPass.last();
    },

    getActiveBackfillPass(): { done: number; total: number } | null {
      return backfillPass.active();
    },

    getReadiness: readiness,

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
          await backfillPass
            .run((onProgress) => p.backfillAll(onProgress))
            .catch((err: unknown) => {
              logger.warn({ err }, "embedding backfill failed");
            });
        })
        .catch((err: unknown) => {
          logger.warn({ err }, "embedding backfill could not start");
        });
    },

    terminate(): void {
      // Stops the backfill at its NEXT gate check. A run already asleep inside the shared battery
      // gate's poll loop keeps polling until that gate's own `stop()` fires — this flag is checked
      // before entering it, not while waiting in it. Production ends both: `platform/assemble.ts`
      // registers the gate's `stop` in `sidecarStops`.
      stopped = true;
    },
  };
}
