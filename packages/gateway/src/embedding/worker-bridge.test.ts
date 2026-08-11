import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";

import { type EmbeddingWarmingError, isEmbeddingWarmingError } from "./embedding-readiness.ts";
import type { EmbeddingRuntime } from "./embedding-runtime.ts";
import { tryCreateEmbeddingWorkerBridge } from "./worker-bridge.ts";

// Real, unique temp root for the fake model/data dir (S5443). The worker is faked —
// nothing is written under this path.
const DATA_DIR = mkdtempSync(join(tmpdir(), "nimbus-worker-bridge-test-"));

interface PostedMessage {
  readonly type: string;
  readonly [key: string]: unknown;
}

interface FakeWorkerHandle {
  fire: (data: unknown, origin?: string) => void;
  fireError: (init: { message: string; filename?: string; lineno?: number }) => void;
  posted: () => readonly PostedMessage[];
  terminated: () => boolean;
}

const handles: FakeWorkerHandle[] = [];

function installFakeWorker(opts: { throwOnConstruct?: boolean } = {}): void {
  class FakeWorker {
    public onmessage: ((ev: MessageEvent) => void) | null = null;
    public onerror: ((ev: ErrorEvent) => void) | null = null;
    private readonly _posted: PostedMessage[] = [];
    private _terminated = false;
    constructor(_url: string) {
      if (opts.throwOnConstruct === true) {
        throw new Error("worker construction failed");
      }
      const handle: FakeWorkerHandle = {
        fire: (data: unknown, origin?: string): void => {
          if (this.onmessage === null) {
            return;
          }
          this.onmessage({
            data,
            origin: origin ?? "",
          } as MessageEvent);
        },
        fireError: (init): void => {
          this.onerror?.({
            message: init.message,
            filename: init.filename ?? "",
            lineno: init.lineno ?? 0,
          } as ErrorEvent);
        },
        posted: (): readonly PostedMessage[] => this._posted,
        terminated: (): boolean => this._terminated,
      };
      handles.push(handle);
    }
    public postMessage(msg: unknown): void {
      this._posted.push(msg as PostedMessage);
    }
    public terminate(): void {
      this._terminated = true;
    }
  }
  (globalThis as unknown as { Worker: unknown }).Worker = FakeWorker as unknown as typeof Worker;
}

const originalWorker = (globalThis as unknown as { Worker?: unknown }).Worker;

beforeEach(() => {
  handles.length = 0;
});

afterEach(() => {
  if (originalWorker === undefined) {
    Reflect.deleteProperty(globalThis, "Worker");
  } else {
    (globalThis as unknown as { Worker: unknown }).Worker = originalWorker;
  }
});

function makeBridge(): EmbeddingRuntime {
  const logger = pino({ level: "silent" });
  const bridge = tryCreateEmbeddingWorkerBridge(
    ":memory:",
    DATA_DIR,
    { chunkTokens: 256, chunkOverlapTokens: 32, backfillBatchSize: 8 },
    logger,
  );
  if (bridge === null) {
    throw new Error("expected non-null bridge");
  }
  return bridge;
}

function currentHandle(): FakeWorkerHandle {
  const h = handles.at(-1);
  if (h === undefined) {
    throw new Error("expected at least one fake worker handle");
  }
  return h;
}

describe("tryCreateEmbeddingWorkerBridge", () => {
  test("returns null when the Worker constructor throws (degraded path)", () => {
    installFakeWorker({ throwOnConstruct: true });
    const logger = pino({ level: "silent" });
    const bridge = tryCreateEmbeddingWorkerBridge(
      ":memory:",
      DATA_DIR,
      { chunkTokens: 256, chunkOverlapTokens: 32, backfillBatchSize: 8 },
      logger,
    );
    expect(bridge).toBeNull();
  });

  test("a worker error flips readiness from 'warming' to 'unavailable' with the reason", () => {
    // Without an onerror handler a dying Bun worker is COMPLETELY silent — the parent neither
    // crashes nor logs — so readiness would sit at 'warming' for the full 600 s init window and
    // read as "still downloading the model" rather than "dead".
    installFakeWorker();
    const bridge = makeBridge();
    try {
      expect(bridge.getReadiness().state).toBe("warming");
      currentHandle().fireError({ message: "onnxruntime failed to load" });
      const r = bridge.getReadiness();
      expect(r.state).toBe("unavailable");
      expect(r.reason).toBe("onnxruntime failed to load");
    } finally {
      bridge.terminate();
    }
  });

  test("a worker error settles the init gate instead of leaving it pending forever", async () => {
    installFakeWorker();
    const bridge = makeBridge();
    try {
      currentHandle().fireError({ message: "worker died" });
      // embedQuery must stop throwing EmbeddingWarmingError once the worker is known dead.
      await expect(bridge.embedQuery("hello")).resolves.toBeNull();
    } finally {
      bridge.terminate();
    }
  });

  test("an empty worker error message still yields a usable reason", () => {
    installFakeWorker();
    const bridge = makeBridge();
    try {
      currentHandle().fireError({ message: "" });
      expect(bridge.getReadiness().reason).toBe("embedding worker errored");
    } finally {
      bridge.terminate();
    }
  });

  test("a worker error AFTER ready does not un-ready a working runtime", () => {
    installFakeWorker();
    const bridge = makeBridge();
    try {
      currentHandle().fire({ type: "ready" });
      expect(bridge.getReadiness().state).toBe("ready");
      currentHandle().fireError({ message: "late blip" });
      expect(bridge.getReadiness().state).toBe("ready");
    } finally {
      bridge.terminate();
    }
  });

  test("posts init message synchronously to the worker", () => {
    installFakeWorker();
    const bridge = makeBridge();
    try {
      const posted = currentHandle().posted();
      expect(posted).toHaveLength(1);
      expect(posted[0]?.["type"]).toBe("init");
      expect(posted[0]?.["dbPath"]).toBe(":memory:");
    } finally {
      bridge.terminate();
    }
  });

  test("flips workerReady on ready message; embed query resolves to vector", async () => {
    installFakeWorker();
    const bridge = makeBridge();
    try {
      const handle = currentHandle();
      handle.fire({ type: "ready" });
      await Promise.resolve();

      const pending = bridge.embedQuery("hello world");
      const sent = handle
        .posted()
        .find((m): m is PostedMessage & { id: string } => m["type"] === "embed_texts");
      expect(sent).toBeDefined();
      const id = sent?.["id"];
      expect(typeof id).toBe("string");
      handle.fire({
        type: "embed_texts_result",
        id,
        ok: true,
        vectors: [[0.1, 0.2, 0.3]],
      });
      const result = await pending;
      expect(result).not.toBeNull();
      expect(result).toHaveLength(3);
      expect(result?.[0]).toBeCloseTo(0.1, 5);
    } finally {
      bridge.terminate();
    }
  });

  test("embed query resolves to null when worker reports ok:false", async () => {
    installFakeWorker();
    const bridge = makeBridge();
    try {
      const handle = currentHandle();
      handle.fire({ type: "ready" });
      await Promise.resolve();

      const pending = bridge.embedQuery("nope");
      const sent = handle.posted().find((m) => m["type"] === "embed_texts");
      const id = sent?.["id"] as string | undefined;
      handle.fire({
        type: "embed_texts_result",
        id,
        ok: false,
        error: "model not loaded",
      });
      const result = await pending;
      expect(result).toBeNull();
    } finally {
      bridge.terminate();
    }
  });

  // #928 false-green guard. This test previously asserted `null` — which is exactly the bug:
  // hybrid search with a null query vector silently degrades to BM25, and a query with no
  // lexical overlap then returns `[]`, indistinguishable from a legitimate "nothing matched".
  test("embedQuery THROWS the warming condition (never a null vector) before ready", async () => {
    installFakeWorker();
    const bridge = makeBridge();
    try {
      const handle = currentHandle();
      const before = handle.posted().length;
      let resolved: unknown = "not-called";
      let thrown: unknown;
      try {
        resolved = await bridge.embedQuery("warmup");
      } catch (err) {
        thrown = err;
      }
      expect(resolved).toBe("not-called");
      expect(isEmbeddingWarmingError(thrown)).toBe(true);
      expect((thrown as EmbeddingWarmingError).readiness.state).toBe("warming");
      const after = handle
        .posted()
        .slice(before)
        .filter((m) => m["type"] === "embed_texts");
      expect(after).toHaveLength(0);
    } finally {
      bridge.terminate();
    }
  });

  test("getReadiness walks warming -> ready, and warming -> unavailable on init_error", async () => {
    installFakeWorker();
    const bridge = makeBridge();
    try {
      const handle = currentHandle();
      expect(bridge.getReadiness().state).toBe("warming");
      handle.fire({ type: "model_progress", file: "model.onnx", loadedBytes: 5, totalBytes: 20 });
      const warming = bridge.getReadiness();
      expect(warming.state).toBe("warming");
      expect(warming.download).toEqual({
        file: "model.onnx",
        loadedBytes: 5,
        totalBytes: 20,
        percent: 25,
      });
      handle.fire({ type: "ready" });
      const ready = bridge.getReadiness();
      expect(ready.state).toBe("ready");
      expect(ready.download).toBeNull();
      expect(ready.model).toBe("all-MiniLM-L6-v2");
      expect(ready.dims).toBe(384);
    } finally {
      bridge.terminate();
    }

    installFakeWorker();
    const failing = makeBridge();
    try {
      currentHandle().fire({ type: "init_error", message: "ENOTFOUND huggingface.co" });
      const r = failing.getReadiness();
      expect(r.state).toBe("unavailable");
      expect(r.reason).toContain("ENOTFOUND");
      // `unavailable` is permanent for this process, so `null` is the honest answer here.
      expect(await failing.embedQuery("q")).toBeNull();
    } finally {
      failing.terminate();
    }
  });

  test("malformed model_progress messages are ignored", () => {
    installFakeWorker();
    const bridge = makeBridge();
    try {
      const handle = currentHandle();
      handle.fire({ type: "model_progress" });
      handle.fire({ type: "model_progress", file: 1, loadedBytes: 1, totalBytes: 2 });
      expect(bridge.getReadiness().download).toBeNull();
      handle.fire({
        type: "model_progress",
        file: "f",
        loadedBytes: 1,
        totalBytes: 0,
        percent: 42,
      });
      expect(bridge.getReadiness().download?.percent).toBe(42);
    } finally {
      bridge.terminate();
    }
  });

  test("scheduleItemEmbedding is a no-op before ready, posts after ready", () => {
    installFakeWorker();
    const bridge = makeBridge();
    try {
      const handle = currentHandle();
      bridge.scheduleItemEmbedding("item-pre");
      const preCount = handle.posted().filter((m) => m["type"] === "embed_item").length;
      expect(preCount).toBe(0);

      handle.fire({ type: "ready" });
      bridge.scheduleItemEmbedding("item-post-1");
      bridge.scheduleItemEmbedding("item-post-2");
      const embedItems = handle
        .posted()
        .filter((m): m is PostedMessage & { itemId: string } => m["type"] === "embed_item");
      expect(embedItems).toHaveLength(2);
      expect(embedItems[0]?.["itemId"]).toBe("item-post-1");
      expect(embedItems[1]?.["itemId"]).toBe("item-post-2");
    } finally {
      bridge.terminate();
    }
  });

  test("handleMessage tolerates non-object payloads, arrays, and unknown types", () => {
    installFakeWorker();
    const bridge = makeBridge();
    try {
      const handle = currentHandle();
      handle.fire(null);
      handle.fire("not-an-object");
      handle.fire([1, 2, 3]);
      handle.fire({ type: "no_such_type" });
      handle.fire({});
      handle.fire({ type: "init_error", message: 123 });
      expect(bridge.getBackfillProgress()).toBeNull();
      handle.fire({ type: "backfill_progress", done: "x", total: "y" });
      expect(bridge.getBackfillProgress()).toBeNull();
      handle.fire({ type: "backfill_progress", done: 3, total: 10 });
      expect(bridge.getBackfillProgress()).toEqual({ done: 3, total: 10 });
      handle.fire({ type: "backfill_done", success: true });
      handle.fire({ type: "backfill_done", success: false });
      handle.fire({ type: "embed_texts_result", id: 42 });
      handle.fire({
        type: "embed_texts_result",
        id: "no-such-id",
        ok: true,
        vectors: [[1, 2]],
      });
    } finally {
      bridge.terminate();
    }
  });

  test("rejects messages from disallowed origins", async () => {
    installFakeWorker();
    const g = globalThis as typeof globalThis & { origin?: unknown };
    const originalOrigin = g.origin;
    Object.defineProperty(g, "origin", {
      value: "https://nimbus.test",
      configurable: true,
      writable: true,
    });
    const bridge = makeBridge();
    try {
      const handle = currentHandle();
      handle.fire({ type: "ready" }, "https://evil.example");
      // The cross-origin "ready" was dropped, so the bridge is STILL warming — and a warming
      // bridge signals that, it does not fake a null vector.
      await expect(bridge.embedQuery("ignored")).rejects.toThrow(/warming up/);
      handle.fire({ type: "ready" }, "https://nimbus.test");
      const pending = bridge.embedQuery("hi");
      const sent = handle.posted().find((m) => m["type"] === "embed_texts");
      const id = sent?.["id"] as string;
      handle.fire(
        { type: "embed_texts_result", id, ok: true, vectors: [[0.5]] },
        "https://nimbus.test",
      );
      const ok = await pending;
      expect(ok).not.toBeNull();
    } finally {
      bridge.terminate();
      if (originalOrigin === undefined) {
        Reflect.deleteProperty(g, "origin");
      } else {
        Object.defineProperty(g, "origin", {
          value: originalOrigin,
          configurable: true,
          writable: true,
        });
      }
    }
  });

  test("settleGate is idempotent: init_error after ready does not reject", async () => {
    installFakeWorker();
    const bridge = makeBridge();
    try {
      const handle = currentHandle();
      handle.fire({ type: "ready" });
      handle.fire({ type: "init_error", message: "late error" });
      const pending = bridge.embedQuery("ready check");
      const sent = handle.posted().find((m) => m["type"] === "embed_texts");
      expect(sent).toBeDefined();
      handle.fire({
        type: "embed_texts_result",
        id: sent?.["id"] as string,
        ok: true,
        vectors: [[1]],
      });
      await pending;
    } finally {
      bridge.terminate();
    }
  });

  test("init_error before ready settles gate to rejected", async () => {
    installFakeWorker();
    const bridge = makeBridge();
    try {
      const handle = currentHandle();
      handle.fire({ type: "init_error", message: "model download failed" });
      const result = await bridge.embedQuery("anything");
      expect(result).toBeNull();
    } finally {
      bridge.terminate();
    }
  });

  test("getEmbeddingModel + getEmbeddingDims return static values", () => {
    installFakeWorker();
    const bridge = makeBridge();
    try {
      expect(typeof bridge.getEmbeddingModel()).toBe("string");
      expect(bridge.getEmbeddingDims()).toBe(384);
      expect(bridge.startBackgroundJobs()).toBeUndefined();
    } finally {
      bridge.terminate();
    }
  });

  test("embedQueryDual THROWS the warming condition (never the all-null shape) before ready", async () => {
    installFakeWorker();
    const bridge = makeBridge();
    try {
      await expect(bridge.embedQueryDual("hi")).rejects.toThrow(/warming up/);
    } finally {
      bridge.terminate();
    }
  });

  test("embedQueryDual returns the all-null shape once the worker is UNAVAILABLE", async () => {
    installFakeWorker();
    const bridge = makeBridge();
    try {
      currentHandle().fire({ type: "init_error", message: "no model" });
      const result = await bridge.embedQueryDual("hi");
      expect(result.vec384).toBeNull();
      expect(result.vec1536).toBeNull();
      expect(result.model384).toBeNull();
      expect(result.model1536).toBeNull();
    } finally {
      bridge.terminate();
    }
  });

  test("embedQueryDual populates vec384 + model384 only after ready", async () => {
    installFakeWorker();
    const bridge = makeBridge();
    try {
      const handle = currentHandle();
      handle.fire({ type: "ready" });
      const pending = bridge.embedQueryDual("hello");
      const sent = handle.posted().find((m) => m["type"] === "embed_texts");
      handle.fire({
        type: "embed_texts_result",
        id: sent?.["id"] as string,
        ok: true,
        vectors: [[0.7, 0.8]],
      });
      const result = await pending;
      expect(result.vec384).not.toBeNull();
      expect(result.vec1536).toBeNull();
      expect(typeof result.model384).toBe("string");
      expect(result.model1536).toBeNull();
    } finally {
      bridge.terminate();
    }
  });

  test("terminate clears pending callbacks and tolerates worker.terminate() throwing", async () => {
    installFakeWorker();
    const bridge = makeBridge();
    const handle = currentHandle();
    handle.fire({ type: "ready" });
    const pending = bridge.embedQuery("never-responds");
    await Promise.resolve();
    bridge.terminate();
    const result = await pending;
    expect(result).toBeNull();
    expect(handle.terminated()).toBe(true);
  });

  test("returns a bridge synchronously without blocking on worker init (real Worker)", () => {
    const logger = pino({ level: "silent" });
    const start = Date.now();
    const bridge = tryCreateEmbeddingWorkerBridge(
      ":memory:",
      DATA_DIR,
      { chunkTokens: 256, chunkOverlapTokens: 32, backfillBatchSize: 8 },
      logger,
    );
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(1000);
    expect(bridge).not.toBeNull();
    if (bridge !== null) {
      expect(bridge.scheduleItemEmbedding("any-id")).toBeUndefined();
      // Warming, so this rejects rather than resolving null; swallow it here — the point of
      // THIS test is that construction did not block on the model.
      const queryResult = bridge.embedQuery("hello").catch(() => null);
      expect(queryResult).toBeInstanceOf(Promise);
      expect(bridge.getReadiness().state).toBe("warming");
      bridge.terminate();
    }
  });
});
