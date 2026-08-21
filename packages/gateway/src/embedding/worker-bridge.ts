import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Logger } from "pino";

import type { NimbusEmbeddingToml } from "../config/nimbus-toml.ts";
import { processEnvGet } from "../platform/env-access.ts";
import { EMBEDDING_WORKER_PATH } from "../workers/embedded-workers.ts";
import {
  downloadPercent,
  type EmbeddingModelDownload,
  type EmbeddingReadiness,
  type EmbeddingReadinessState,
  EmbeddingWarmingError,
  NO_DUAL_VECTORS,
} from "./embedding-readiness.ts";
import type { EmbeddingRuntime } from "./embedding-runtime.ts";
import { LOCAL_EMBEDDING_MODEL_ID } from "./model.ts";
import type { EmbeddingDualVectors } from "./types.ts";

type Pending = {
  resolve: (v: Float32Array | null) => void;
  timer: ReturnType<typeof setTimeout>;
};

const DEFAULT_EMBEDDING_INIT_TIMEOUT_MS = 600_000;

function resolveEmbeddingInitTimeoutMs(): number {
  const raw = processEnvGet("NIMBUS_EMBEDDING_INIT_TIMEOUT_MS");
  if (raw === undefined || raw === "") {
    return DEFAULT_EMBEDDING_INIT_TIMEOUT_MS;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    return DEFAULT_EMBEDDING_INIT_TIMEOUT_MS;
  }
  return n;
}

export function tryCreateEmbeddingWorkerBridge(
  dbPath: string,
  dataDir: string,
  toml: Pick<NimbusEmbeddingToml, "chunkTokens" | "chunkOverlapTokens" | "backfillBatchSize">,
  logger: Logger,
): EmbeddingRuntime | null {
  let worker: Worker;
  try {
    // Path from `workers/embedded-workers.ts`, never `new URL(..., import.meta.url)`. That form
    // resolves at RUNTIME, so `bun build --compile` never sees the worker and the spawn throws
    // `ModuleNotFound resolving "B:\~BUN\root\embedding-worker.ts"` inside the binary. The catch
    // below then swallowed it and returned null, which is why semantic search was silently dead in
    // every packaged release while every source-tree test passed (F15).
    worker = new Worker(EMBEDDING_WORKER_PATH);
  } catch (err) {
    logger.warn({ err }, "could not spawn embedding worker");
    return null;
  }
  const bridge = new EmbeddingWorkerBridge(worker, dbPath, join(dataDir, "models"), toml, logger);
  bridge
    .waitUntilReady(resolveEmbeddingInitTimeoutMs())
    .then(() => {
      logger.info(
        { msg: "embedding_worker_ready" },
        "embedding worker initialized; semantic search is now active",
      );
    })
    .catch((err: unknown) => {
      // The timeout arm of waitUntilReady is the ONLY thing that ends an indefinite warm-up:
      // record it as `unavailable` so callers stop being told "still warming" forever.
      bridge.markUnavailable(err instanceof Error ? err.message : String(err));
      logger.warn(
        { err },
        "embedding worker failed to initialize; semantic search disabled until the next gateway restart",
      );
    });
  return bridge;
}

class EmbeddingWorkerBridge implements EmbeddingRuntime {
  private static isAcceptableEmbeddingWorkerOrigin(ev: MessageEvent): boolean {
    const o = ev.origin;
    if (o === "" || o === "null") {
      return true;
    }
    const g = globalThis as typeof globalThis & { origin?: unknown };
    const selfO = typeof g.origin === "string" ? g.origin : "";
    if (selfO === "") {
      return true;
    }
    return o === selfO;
  }

  private readonly pending = new Map<string, Pending>();
  private progress: { done: number; total: number } | null = null;
  private gateSettled = false;
  private workerReady = false;
  private readonly startedMs = Date.now();
  private settledMs: number | null = null;
  private failureReason: string | null = null;
  private download: EmbeddingModelDownload | null = null;
  private readonly resolveGate: () => void;
  private readonly rejectGate: (e: Error) => void;
  private readonly gate: Promise<void>;

  constructor(
    private readonly worker: Worker,
    dbPath: string,
    cacheDir: string,
    toml: Pick<NimbusEmbeddingToml, "chunkTokens" | "chunkOverlapTokens" | "backfillBatchSize">,
    private readonly logger: Logger,
  ) {
    let res!: () => void;
    let rej!: (e: Error) => void;
    this.gate = new Promise<void>((resolve, reject) => {
      res = resolve;
      rej = reject;
    });
    this.resolveGate = res;
    this.rejectGate = rej;

    this.worker.onmessage = (ev: MessageEvent) => {
      if (!EmbeddingWorkerBridge.isAcceptableEmbeddingWorkerOrigin(ev)) {
        return;
      }
      this.handleMessage(ev.data);
    };

    // Without this the worker dies COMPLETELY silently: an uncaught throw inside a Bun Worker
    // neither crashes the parent nor prints anything, so semantic search would sit in `warming`
    // until the 600 s init timeout and read as "still downloading the model" rather than "dead".
    this.worker.onerror = (ev: ErrorEvent): void => {
      const reason = ev.message === "" ? "embedding worker errored" : ev.message;
      this.logger.warn(
        { msg: "embedding_worker_error", filename: ev.filename, lineno: ev.lineno },
        `embedding worker error: ${reason}`,
      );
      this.markUnavailable(reason);
      this.settleGate(false, new Error(reason));
    };

    this.worker.postMessage({
      type: "init",
      dbPath,
      cacheDir,
      toml,
    });
  }

  waitUntilReady(timeoutMs: number): Promise<void> {
    const timeout = new Promise<void>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`embedding worker init timed out after ${String(timeoutMs)}ms`));
      }, timeoutMs);
    });
    return Promise.race([this.gate, timeout]);
  }

  private settleGate(ok: boolean, err?: Error): void {
    if (this.gateSettled) {
      return;
    }
    this.gateSettled = true;
    if (ok) {
      this.resolveGate();
    } else {
      this.rejectGate(err ?? new Error("embedding worker init failed"));
    }
  }

  private static asRecord(data: unknown): Record<string, unknown> | undefined {
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return undefined;
    }
    return data as Record<string, unknown>;
  }

  private handleReadyMessage(): void {
    this.workerReady = true;
    this.settledMs ??= Date.now();
    this.download = null;
    this.settleGate(true);
  }

  private handleInitErrorMessage(rec: Record<string, unknown>): void {
    const msg = rec["message"];
    if (typeof msg === "string") {
      this.markUnavailable(msg);
      this.settleGate(false, new Error(msg));
    }
  }

  private handleModelProgressMessage(rec: Record<string, unknown>): void {
    const file = rec["file"];
    const loaded = rec["loadedBytes"];
    const total = rec["totalBytes"];
    if (typeof file !== "string" || typeof loaded !== "number" || typeof total !== "number") {
      return;
    }
    const pct = rec["percent"];
    this.download = {
      file,
      loadedBytes: loaded,
      totalBytes: total,
      percent:
        typeof pct === "number" && Number.isFinite(pct)
          ? Math.min(100, Math.max(0, pct))
          : downloadPercent(loaded, total),
    };
  }

  /** Records a terminal init failure (worker `init_error`, or the init-timeout arm). */
  markUnavailable(reason: string): void {
    if (this.workerReady) {
      return;
    }
    this.failureReason ??= reason;
    this.settledMs ??= Date.now();
    this.download = null;
  }

  private handleBackfillProgressMessage(rec: Record<string, unknown>): void {
    const done = rec["done"];
    const total = rec["total"];
    if (typeof done === "number" && typeof total === "number") {
      this.progress = { done: Math.floor(done), total: Math.floor(total) };
    }
  }

  private handleEmbedTextsResultMessage(rec: Record<string, unknown>): void {
    const id = rec["id"];
    if (typeof id !== "string") {
      return;
    }
    const p = this.pending.get(id);
    if (p === undefined) {
      return;
    }
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (rec["ok"] === true && Array.isArray(rec["vectors"])) {
      const first = rec["vectors"][0];
      if (Array.isArray(first)) {
        p.resolve(new Float32Array(first.map(Number)));
        return;
      }
    }
    p.resolve(null);
  }

  private handleMessage(data: unknown): void {
    const rec = EmbeddingWorkerBridge.asRecord(data);
    if (rec === undefined) {
      return;
    }
    const t = rec["type"];
    if (t === "ready") {
      this.handleReadyMessage();
      return;
    }
    if (t === "init_error") {
      this.handleInitErrorMessage(rec);
      return;
    }
    if (t === "backfill_progress") {
      this.handleBackfillProgressMessage(rec);
      return;
    }
    if (t === "model_progress") {
      this.handleModelProgressMessage(rec);
      return;
    }
    if (t === "backfill_done") {
      if (rec["success"] === false) {
        this.logger.warn(
          { msg: "embedding_backfill_failed" },
          "embedding backfill did not complete successfully",
        );
      }
      return;
    }
    if (t === "embed_texts_result") {
      this.handleEmbedTextsResultMessage(rec);
    }
  }

  scheduleItemEmbedding(itemId: string): void {
    if (!this.workerReady) {
      return;
    }
    this.worker.postMessage({ type: "embed_item", itemId });
  }

  getReadiness(): EmbeddingReadiness {
    const state: EmbeddingReadinessState = this.readinessState();
    const end = state === "warming" ? Date.now() : (this.settledMs ?? Date.now());
    return {
      state,
      elapsedMs: Math.max(0, end - this.startedMs),
      model: LOCAL_EMBEDDING_MODEL_ID,
      dims: 384,
      download: state === "warming" ? this.download : null,
      reason: this.failureReason,
    };
  }

  private readinessState(): EmbeddingReadinessState {
    if (this.workerReady) {
      return "ready";
    }
    return this.failureReason === null ? "warming" : "unavailable";
  }

  /**
   * The false-green guard (#928). A not-yet-ready worker must NOT hand back a null vector:
   * hybrid search would silently degrade to BM25 and report `[]` as a legitimate zero.
   * `unavailable` still returns null — that absence is permanent for this process.
   */
  async embedQuery(text: string): Promise<Float32Array | null> {
    if (!this.workerReady) {
      const readiness = this.getReadiness();
      if (readiness.state === "warming") {
        throw new EmbeddingWarmingError(readiness);
      }
      return null;
    }
    const id = randomUUID();
    return new Promise<Float32Array | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, 60_000);
      this.pending.set(id, { resolve, timer });
      this.worker.postMessage({ type: "embed_texts", id, texts: [text] });
    }).catch((err: unknown) => {
      this.logger.warn({ err }, "embedQuery failed");
      return null;
    });
  }

  async embedQueryDual(text: string): Promise<EmbeddingDualVectors> {
    const vec = await this.embedQuery(text);
    if (vec === null) {
      return { ...NO_DUAL_VECTORS };
    }
    return {
      vec384: vec,
      vec1536: null,
      model384: this.getEmbeddingModel(),
      model1536: null,
    };
  }

  getEmbeddingModel(): string {
    return LOCAL_EMBEDDING_MODEL_ID;
  }

  getEmbeddingDims(): number {
    return 384;
  }

  getBackfillProgress(): { done: number; total: number } | null {
    return this.progress;
  }

  startBackgroundJobs(): void {
    /* worker backfills after ready */
  }

  terminate(): void {
    // A torn-down bridge must stop claiming "warming" — nothing will ever make it ready.
    this.markUnavailable("embedding worker terminated");
    this.worker.onmessage = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve(null);
    }
    this.pending.clear();
    try {
      this.worker.terminate();
    } catch {
      /* ignore */
    }
  }
}
