import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import pino from "pino";
import type { IndexedItem } from "../embedding/types.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { tryLoadSqliteVec } from "../index/sqlite-vec-load.ts";
import { MockVault } from "../vault/mock.ts";
import {
  dispatchIndexReembedRpc,
  embedBatchWithRetry,
  IndexReembedRpcError,
  isRetryableStatus,
  type ReembedSink,
} from "./index-reembed-rpc.ts";

function freshCtx() {
  const db = new Database(":memory:");
  tryLoadSqliteVec(db);
  runIndexedSchemaMigrations(db, 30);
  const events: Array<{ method: string; params: unknown }> = [];
  const ctx = {
    db,
    vault: new MockVault(),
    paths: { dataDir: "/tmp/nimbus-test" },
    logger: pino({ level: "silent" }),
    notify: (method: string, params: unknown) => {
      events.push({ method, params });
    },
  };
  return { db, ctx, events };
}

describe("dispatchIndexReembedRpc", () => {
  test("returns { kind: 'miss' } for unknown methods", async () => {
    const { ctx } = freshCtx();
    const out = await dispatchIndexReembedRpc("foo.bar", null, ctx);
    expect(out.kind).toBe("miss");
  });

  test("rejects missing model param", async () => {
    const { ctx } = freshCtx();
    await expect(dispatchIndexReembedRpc("index.reembed", {}, ctx)).rejects.toBeInstanceOf(
      IndexReembedRpcError,
    );
  });

  test("dryRun returns { jobId } and emits done notification", async () => {
    const { ctx, events } = freshCtx();
    const out = await dispatchIndexReembedRpc(
      "index.reembed",
      { model: "Xenova/all-MiniLM-L6-v2", dryRun: true, batchSize: 100 },
      ctx,
    );
    expect(out.kind).toBe("hit");
    const hit = (out as { kind: "hit"; value: { jobId: string } }).value;
    expect(hit.jobId).toMatch(/^reembed_/);
    await new Promise((r) => setTimeout(r, 50));
    expect(events.find((e) => e.method === "index.reembedDone")).toBeDefined();
  });

  test("openai:* without vault key yields fatal error", async () => {
    const { ctx, events } = freshCtx();
    const out = await dispatchIndexReembedRpc(
      "index.reembed",
      { model: "openai:text-embedding-3-small", batchSize: 100 },
      ctx,
    );
    expect(out.kind).toBe("hit");
    await new Promise((r) => setTimeout(r, 50));
    const err = events.find((e) => e.method === "index.reembedError");
    expect(err).toBeDefined();
    expect((err?.params as { message?: string }).message).toMatch(/openai\.api_key/);
  });

  test("cancel for unknown jobId returns { cancelled: false }", async () => {
    const { ctx } = freshCtx();
    const out = await dispatchIndexReembedRpc(
      "index.reembedCancel",
      { jobId: "reembed_does_not_exist" },
      ctx,
    );
    expect(out.kind).toBe("hit");
    expect((out as { kind: "hit"; value: { cancelled: boolean } }).value.cancelled).toBe(false);
  });
});

const SAMPLE_ITEM: IndexedItem = {
  id: "x:1",
  service: "x",
  type: "t",
  title: "T",
  body_preview: null,
};

function failingSink(err: unknown, failFirstNCalls = Number.POSITIVE_INFINITY): ReembedSink {
  let calls = 0;
  return {
    embedItem: async () => {
      calls += 1;
      if (calls <= failFirstNCalls) throw err;
    },
  };
}

describe("isRetryableStatus", () => {
  test("429 and 5xx are retryable; everything else is not", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(599)).toBe(true);
    expect(isRetryableStatus(499)).toBe(false);
    expect(isRetryableStatus(600)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(200)).toBe(false);
    expect(isRetryableStatus(undefined)).toBe(false);
  });
});

describe("embedBatchWithRetry", () => {
  test("happy path counts every item as succeeded", async () => {
    const { ctx } = freshCtx();
    const counters = { succeeded: 0, skipped: 0 };
    await embedBatchWithRetry(failingSink(null, 0), ctx, [SAMPLE_ITEM], 0, counters);
    expect(counters).toEqual({ succeeded: 1, skipped: 0 });
  });

  test("retryable error then success retries and counts succeeded", async () => {
    const { ctx } = freshCtx();
    const counters = { succeeded: 0, skipped: 0 };
    const sink = failingSink({ status: 429, retryAfterMs: 0 }, 1);
    await embedBatchWithRetry(sink, ctx, [SAMPLE_ITEM], 0, counters);
    expect(counters).toEqual({ succeeded: 1, skipped: 0 });
  });

  test("retryable error that persists skips the whole slice", async () => {
    const { ctx } = freshCtx();
    const counters = { succeeded: 0, skipped: 0 };
    const sink = failingSink({ status: 503, retryAfterMs: 0 });
    await embedBatchWithRetry(sink, ctx, [SAMPLE_ITEM, SAMPLE_ITEM], 0, counters);
    expect(counters).toEqual({ succeeded: 0, skipped: 2 });
  });

  test("401/403 is a fatal IndexReembedRpcError", async () => {
    const { ctx } = freshCtx();
    const counters = { succeeded: 0, skipped: 0 };
    await expect(
      embedBatchWithRetry(failingSink({ status: 401 }), ctx, [SAMPLE_ITEM], 0, counters),
    ).rejects.toBeInstanceOf(IndexReembedRpcError);
    await expect(
      embedBatchWithRetry(failingSink({ status: 403 }), ctx, [SAMPLE_ITEM], 0, counters),
    ).rejects.toBeInstanceOf(IndexReembedRpcError);
  });

  test("non-retryable error is rethrown unchanged", async () => {
    const { ctx } = freshCtx();
    const counters = { succeeded: 0, skipped: 0 };
    const boom = new Error("boom");
    await expect(
      embedBatchWithRetry(failingSink(boom), ctx, [SAMPLE_ITEM], 0, counters),
    ).rejects.toBe(boom);
  });
});
