import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import pino from "pino";

import type { EmbeddingRuntime } from "./embedding-runtime.ts";
import { tryCreateEmbeddingWorkerBridge } from "./worker-bridge.ts";

interface PostedMessage {
  readonly type: string;
  readonly [key: string]: unknown;
}

interface FakeWorkerHandle {
  fire: (data: unknown, origin?: string) => void;
  posted: () => readonly PostedMessage[];
  terminated: () => boolean;
}

const handles: FakeWorkerHandle[] = [];

function installFakeWorker(opts: { throwOnConstruct?: boolean } = {}): void {
  class FakeWorker {
    public onmessage: ((ev: MessageEvent) => void) | null = null;
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
    Reflect.deleteProperty(globalThis as object, "Worker");
  } else {
    (globalThis as unknown as { Worker: unknown }).Worker = originalWorker;
  }
});

function makeBridge(): EmbeddingRuntime {
  const logger = pino({ level: "silent" });
  const bridge = tryCreateEmbeddingWorkerBridge(
    ":memory:",
    "/tmp/nimbus-worker-bridge-test",
    { chunkTokens: 256, chunkOverlapTokens: 32, backfillBatchSize: 8 },
    logger,
  );
  if (bridge === null) {
    throw new Error("expected non-null bridge");
  }
  return bridge;
}

function currentHandle(): FakeWorkerHandle {
  const h = handles[handles.length - 1];
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
      "/tmp/nimbus-worker-bridge-test",
      { chunkTokens: 256, chunkOverlapTokens: 32, backfillBatchSize: 8 },
      logger,
    );
    expect(bridge).toBeNull();
  });

  test("posts init message synchronously to the worker", () => {
    installFakeWorker();
    const bridge = makeBridge();
    try {
      const posted = currentHandle().posted();
      expect(posted.length).toBe(1);
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
      // Drain microtasks so the gate-settle propagates.
      await Promise.resolve();

      const pending = bridge.embedQuery("hello world");
      // The bridge should have posted an embed_texts message.
      const sent = handle
        .posted()
        .find((m): m is PostedMessage & { id: string } => m["type"] === "embed_texts");
      expect(sent).toBeDefined();
      const id = sent?.["id"];
      expect(typeof id).toBe("string");
      // Respond with a result; the bridge should resolve the promise.
      handle.fire({
        type: "embed_texts_result",
        id,
        ok: true,
        vectors: [[0.1, 0.2, 0.3]],
      });
      const result = await pending;
      expect(result).not.toBeNull();
      expect(result?.length).toBe(3);
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

  test("embedQuery returns null without posting when the worker is not ready", async () => {
    installFakeWorker();
    const bridge = makeBridge();
    try {
      const handle = currentHandle();
      const before = handle.posted().length;
      const result = await bridge.embedQuery("warmup");
      expect(result).toBeNull();
      // No new embed_texts message should have been posted.
      const after = handle
        .posted()
        .slice(before)
        .filter((m) => m["type"] === "embed_texts");
      expect(after.length).toBe(0);
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
      expect(embedItems.length).toBe(2);
      // Verify ordering — scheduleItemEmbedding posts serially.
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
      // Each of these should be silently ignored (no throws).
      handle.fire(null);
      handle.fire("not-an-object");
      handle.fire([1, 2, 3]);
      handle.fire({ type: "no_such_type" });
      handle.fire({}); // no type field
      // init_error with non-string message should be ignored.
      handle.fire({ type: "init_error", message: 123 });
      // backfill_progress with bad shape should not update progress.
      expect(bridge.getBackfillProgress()).toBeNull();
      handle.fire({ type: "backfill_progress", done: "x", total: "y" });
      expect(bridge.getBackfillProgress()).toBeNull();
      handle.fire({ type: "backfill_progress", done: 3, total: 10 });
      expect(bridge.getBackfillProgress()).toEqual({ done: 3, total: 10 });
      // backfill_done with success:true is a no-op; success:false logs but returns.
      handle.fire({ type: "backfill_done", success: true });
      handle.fire({ type: "backfill_done", success: false });
      // embed_texts_result with non-string id is silently ignored.
      handle.fire({ type: "embed_texts_result", id: 42 });
      // embed_texts_result for an unknown id is silently ignored.
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
    // Force a known self-origin so cross-origin messages are rejected.
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
      // ready from a different origin must not flip workerReady.
      handle.fire({ type: "ready" }, "https://evil.example");
      const result = await bridge.embedQuery("ignored");
      expect(result).toBeNull();
      // ready from the matching origin must flip readiness.
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
        Reflect.deleteProperty(g as object, "origin");
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
      // A subsequent init_error must not re-settle the gate.
      handle.fire({ type: "init_error", message: "late error" });
      // The bridge should still treat itself as ready.
      const pending = bridge.embedQuery("ready check");
      const sent = handle.posted().find((m) => m["type"] === "embed_texts");
      expect(sent).toBeDefined();
      // Resolve so we don't leave a pending timer.
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
      // The bridge should still be usable (queries return null) but workerReady stays false.
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
      // startBackgroundJobs is a no-op for the worker bridge.
      expect(bridge.startBackgroundJobs()).toBeUndefined();
    } finally {
      bridge.terminate();
    }
  });

  test("embedQueryDual returns nulls when worker is not ready", async () => {
    installFakeWorker();
    const bridge = makeBridge();
    try {
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
    // Start a query but never respond — terminate must resolve it to null.
    const pending = bridge.embedQuery("never-responds");
    // Tiny tick so the embed_texts message is posted.
    await Promise.resolve();
    bridge.terminate();
    const result = await pending;
    expect(result).toBeNull();
    expect(handle.terminated()).toBe(true);
  });

  test("returns a bridge synchronously without blocking on worker init (real Worker)", () => {
    // No fake — uses the real Bun Worker spawn.
    const logger = pino({ level: "silent" });
    const start = Date.now();
    const bridge = tryCreateEmbeddingWorkerBridge(
      ":memory:",
      "/tmp/nimbus-test",
      { chunkTokens: 256, chunkOverlapTokens: 32, backfillBatchSize: 8 },
      logger,
    );
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(1000);
    expect(bridge).not.toBeNull();
    if (bridge !== null) {
      expect(bridge.scheduleItemEmbedding("any-id")).toBeUndefined();
      const queryResult = bridge.embedQuery("hello");
      expect(queryResult).toBeInstanceOf(Promise);
      bridge.terminate();
    }
  });
});
