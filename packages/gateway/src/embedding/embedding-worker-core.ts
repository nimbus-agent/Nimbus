import type { IndexedItem } from "./types.ts";

export type InitMsg = {
  type: "init";
  dbPath: string;
  cacheDir: string;
  toml: {
    chunkTokens: number;
    chunkOverlapTokens: number;
    backfillBatchSize: number;
    /**
     * `[embedding] pause_on_battery`. OPTIONAL on the wire, and absent means `true` at the reader
     * (`embedding-worker.ts`), matching `DEFAULT_NIMBUS_EMBEDDING_TOML`. Absent-means-pause is the
     * conservative direction: the failure mode of a wrongly-paused backfill is a slower index, the
     * failure mode of a wrongly-resumed one is the drained battery the key exists to prevent.
     * The core itself never reads it — only the production `setup` that builds the pipeline does.
     */
    pauseOnBattery?: boolean;
  };
};

export type EmbedTextsMsg = { type: "embed_texts"; id: string; texts: string[] };
export type EmbedItemMsg = { type: "embed_item"; itemId: string };
/**
 * The main thread gave up on `id` (its query timed out). Best-effort: the request is dropped if its
 * embed has not started, and its reply is suppressed either way. An inference already running is
 * NOT interrupted — nothing in the local stack can do that — so this reclaims queue position and
 * silences a reply, never CPU already committed.
 */
export type CancelEmbedMsg = { type: "cancel_embed"; id: string };

export type InMsg = InitMsg | EmbedTextsMsg | EmbedItemMsg | CancelEmbedMsg;

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
      typeof toml?.["backfillBatchSize"] === "number" &&
      // Optional, but never a lie: a non-boolean present value is a malformed message, not a
      // default to be silently substituted.
      (toml["pauseOnBattery"] === undefined || typeof toml["pauseOnBattery"] === "boolean")
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
  if (m["type"] === "cancel_embed") {
    return typeof m["id"] === "string";
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
/**
 * Upper bound on remembered cancellations. Each entry is a UUID string, so this is kilobytes, and
 * the set only grows when a cancel outlives the request it names — a bound, not a tuning knob.
 */
const CANCELLED_MAX = 256;

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
  /**
   * Ids the main thread gave up on. Normally each entry is consumed by the request it names, but a
   * cancel whose request never arrives (the worker restarted in between) would linger, so the set is
   * bounded and evicts oldest-first — a Set iterates in insertion order. Losing the oldest entry
   * costs at most one suppressed reply that the bridge discards anyway for having no pending id.
   */
  private readonly cancelled = new Set<string>();

  constructor(deps: EmbeddingWorkerDeps) {
    this.sendToMain = deps.sendToMain;
    this.setup = deps.setup;
  }

  handleMessage(msg: unknown): void {
    if (!isInMsg(msg)) return;
    // Handled BEFORE the readiness guard below: a cancel for an id from an earlier, still-queued
    // request must land even in the window where the worker is re-initialising, or the id would be
    // remembered as live forever.
    if (msg.type === "cancel_embed") {
      this.cancelled.add(msg.id);
      while (this.cancelled.size > CANCELLED_MAX) {
        const oldest = this.cancelled.values().next();
        if (oldest.done === true) break;
        this.cancelled.delete(oldest.value);
      }
      return;
    }
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
   * re-reads `inFlight` (Promise.all snapshots the Set's iterator synchronously at
   * call time) in case a test interleaves more detached work after the queue drains;
   * the core never self-dispatches, so no re-entrancy occurs here.
   */
  async idle(): Promise<void> {
    await Promise.all(this.inFlight);
    await this.embedChain;
    await Promise.all(this.inFlight);
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
    // Checked twice, and neither check is redundant. BEFORE: the cancel arrived while this request
    // waited its turn behind other work, so the embed never runs — the only real saving available
    // here. AFTER: the cancel arrived mid-inference, which cannot be stopped, so all that is left is
    // not to post a result the main thread has already stopped listening for.
    if (this.takeCancelled(id)) return;
    try {
      const vectors = await pipeline.embedTexts(texts);
      if (this.takeCancelled(id)) return;
      this.sendToMain({
        type: "embed_texts_result",
        id,
        ok: true,
        vectors: vectors.map((v) => Array.from(v)),
      });
    } catch (err) {
      if (this.takeCancelled(id)) return;
      this.sendToMain({ type: "embed_texts_result", id, ok: false, error: errMessage(err) });
    }
  }

  /**
   * True when `id` was cancelled, consuming the record so the set cannot grow without bound: a
   * cancel for an id that never arrives (a worker restarted between the request and the cancel)
   * is the one case that leaves an entry behind, which `CANCELLED_MAX` then bounds.
   */
  private takeCancelled(id: string): boolean {
    return this.cancelled.delete(id);
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
