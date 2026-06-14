import type { IndexedItem } from "./types.ts";

export type InitMsg = {
  type: "init";
  dbPath: string;
  cacheDir: string;
  toml: { chunkTokens: number; chunkOverlapTokens: number; backfillBatchSize: number };
};

export type EmbedTextsMsg = { type: "embed_texts"; id: string; texts: string[] };
export type EmbedItemMsg = { type: "embed_item"; itemId: string };

export type InMsg = InitMsg | EmbedTextsMsg | EmbedItemMsg;

/**
 * Runtime type guard narrowing external (cross-realm) worker input to `InMsg`.
 * `ev.data` arriving on the worker's `onmessage` is untrusted: a malformed
 * payload (e.g. `null`) must not crash the worker. CLAUDE.md non-negotiable #7
 * requires external data to enter as `unknown` and be narrowed before use; the
 * core owns this narrowing (the excluded shell only does the origin check).
 */
export function isInMsg(data: unknown): data is InMsg {
  if (typeof data !== "object" || data === null) return false;
  const m = data as Record<string, unknown>;
  if (m["type"] === "init") {
    const toml = m["toml"] as Record<string, unknown> | undefined;
    return (
      typeof m["dbPath"] === "string" &&
      typeof m["cacheDir"] === "string" &&
      typeof toml?.["chunkTokens"] === "number" &&
      typeof toml?.["chunkOverlapTokens"] === "number" &&
      typeof toml?.["backfillBatchSize"] === "number"
    );
  }
  if (m["type"] === "embed_texts") {
    const texts = m["texts"];
    return (
      typeof m["id"] === "string" &&
      Array.isArray(texts) &&
      // Array.from materializes holes as `undefined` so a sparse array (e.g. `Array(2)`)
      // is rejected — `Array.prototype.every` skips holes and would wrongly pass.
      Array.from(texts).every((t) => typeof t === "string")
    );
  }
  if (m["type"] === "embed_item") {
    return typeof m["itemId"] === "string";
  }
  return false;
}

/**
 * Minimal structural seam over the bun:sqlite `Database` — only the
 * `query(...).get(id)` shape the core uses. A real `Database` is assignable.
 */
export interface EmbeddingWorkerDb {
  query(sql: string): { get(id: string): unknown };
}

/**
 * Minimal structural seam over `SqliteEmbeddingPipeline` — only the methods the
 * core orchestration calls. A real pipeline is assignable.
 */
export interface EmbeddingWorkerPipeline {
  embedTexts(texts: string[]): Promise<Float32Array[]>;
  embedItem(item: IndexedItem): Promise<void>;
  backfillAll(onProgress?: (done: number, total: number) => void): Promise<void>;
}

/**
 * Builds the db + pipeline for an init message. In production this opens the
 * SQLite connection, loads the local embedder, and constructs the pipeline; in
 * tests it returns fakes (no model download, in-memory db).
 */
export type EmbeddingWorkerSetup = (
  msg: InitMsg,
) => Promise<{ db: EmbeddingWorkerDb; pipeline: EmbeddingWorkerPipeline }>;

export type EmbeddingWorkerDeps = {
  sendToMain: (data: unknown) => void;
  setup: EmbeddingWorkerSetup;
};

/**
 * The orchestration extracted from the embedding worker entry point, made
 * unit-testable WITHOUT the Worker realm. Behavior is identical to the
 * pre-extraction worker (init flow + backfill + embed_texts + the serialized
 * embed_item queue). The realm-boundary origin check (`isAcceptableWorkerOrigin`)
 * stays in the residual `onmessage` shell and is NOT part of this core — the core
 * operates on already-parsed payloads.
 */
export class EmbeddingWorkerCore {
  private readonly sendToMain: (data: unknown) => void;
  private readonly setup: EmbeddingWorkerSetup;

  private db: EmbeddingWorkerDb | null = null;
  private pipeline: EmbeddingWorkerPipeline | null = null;
  private ready = false;
  // Set the moment the first `init` is accepted, so a duplicate `init` is ignored
  // rather than orphaning the current db/pipeline and starting an overlapping backfill.
  private initStarted = false;
  private embedChain: Promise<void> = Promise.resolve();
  // Tracks each piece of detached init/embed_texts work (which run concurrently,
  // exactly as the pre-extraction worker's `void (async () => …)()` did) so that
  // `idle()` can await all of it in tests without serializing it.
  private readonly inFlight = new Set<Promise<void>>();

  constructor(deps: EmbeddingWorkerDeps) {
    this.sendToMain = deps.sendToMain;
    this.setup = deps.setup;
  }

  handleMessage(msg: unknown): void {
    if (!isInMsg(msg)) return;
    if (msg.type === "init") {
      if (this.initStarted) return;
      this.initStarted = true;
      this.track(this.runInit(msg));
      return;
    }

    if (!this.ready || this.pipeline === null || this.db === null) {
      return;
    }

    if (msg.type === "embed_texts") {
      const pipeline = this.pipeline;
      const { id, texts } = msg;
      this.track(this.runEmbedTexts(pipeline, id, texts));
      return;
    }

    if (msg.type === "embed_item") {
      const itemId = msg.itemId;
      const conn = this.db;
      const pipeline = this.pipeline;
      this.embedChain = this.embedChain
        .then(async () => {
          const row = conn
            .query("SELECT id, service, type, title, body_preview FROM item WHERE id = ?")
            .get(itemId) as IndexedItem | null | undefined;
          if (row === null || row === undefined) {
            return;
          }
          await pipeline.embedItem(row);
        })
        .catch(() => {
          /*
           * Silent best-effort: preserves pre-extraction behavior. embed_item has
           * no result id to correlate, so a failure is swallowed and the queue
           * keeps draining. DO NOT add logging here — that would be a behavior
           * change (spec §5).
           */
        });
    }
    // Unknown message types fall through with no effect.
  }

  /**
   * Test seam: awaits all detached init/embed_texts work AND the serialized
   * embed_item queue. Every tracked path always resolves (init/embed_texts errors
   * are posted as messages, never thrown), so this cannot hang. The trailing await
   * is a defensive re-snapshot of `inFlight` in case a test interleaves more
   * detached work; the core never self-dispatches, so no re-entrancy occurs here.
   */
  async idle(): Promise<void> {
    await Promise.all([...this.inFlight]);
    await this.embedChain;
    await Promise.all([...this.inFlight]);
  }

  /** Track a detached promise so `idle()` can await it; auto-remove when settled. */
  private track(promise: Promise<void>): void {
    this.inFlight.add(promise);
    void promise.finally(() => {
      this.inFlight.delete(promise);
    });
  }

  private async runInit(msg: InitMsg): Promise<void> {
    try {
      const { db, pipeline } = await this.setup(msg);
      this.db = db;
      this.pipeline = pipeline;
      this.ready = true;
      this.sendToMain({ type: "ready" });
      await this.runBackfill(pipeline);
    } catch (err) {
      this.sendToMain({ type: "init_error", message: errMessage(err) });
    }
  }

  private async runBackfill(pipeline: EmbeddingWorkerPipeline): Promise<void> {
    let success = false;
    try {
      await pipeline.backfillAll((done, total) => {
        this.sendToMain({ type: "backfill_progress", done, total });
      });
      success = true;
    } catch {
      /* best-effort */
    }
    this.sendToMain({ type: "backfill_done", success });
  }

  private async runEmbedTexts(
    pipeline: EmbeddingWorkerPipeline,
    id: string,
    texts: string[],
  ): Promise<void> {
    try {
      const vectors = await pipeline.embedTexts(texts);
      this.sendToMain({
        type: "embed_texts_result",
        id,
        ok: true,
        vectors: vectors.map((v) => Array.from(v)),
      });
    } catch (err) {
      this.sendToMain({ type: "embed_texts_result", id, ok: false, error: errMessage(err) });
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
