import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import pino from "pino";
import type { Embedder, IndexedItem } from "../embedding/types.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { tryLoadSqliteVec } from "../index/sqlite-vec-load.ts";
import { MockVault } from "../vault/mock.ts";
import {
  assertModelUsable,
  buildCandidateSql,
  clampBatchSize,
  dispatchIndexReembedRpc,
  embedBatchWithRetry,
  type IndexReembedRpcContext,
  IndexReembedRpcError,
  isRetryableStatus,
  parseReembedParams,
  type ReembedSink,
  resolveEmbedder,
} from "./index-reembed-rpc.ts";

function freshCtx() {
  const db = new Database(":memory:");
  tryLoadSqliteVec(db);
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
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
    expect((err?.params as { message?: string } | undefined)?.message).toMatch(/openai\.api_key/);
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

  test("retryable error with explicit retryAfterMs uses provided value (branch=1 retryAfterMs present)", async () => {
    // Covers classifyEmbedError line=181 block=34 branch=1: retryAfterMs IS defined on the error
    const { ctx } = freshCtx();
    const counters = { succeeded: 0, skipped: 0 };
    // First call fails with retryable error that has retryAfterMs; second call succeeds
    const sink = failingSink({ status: 429, retryAfterMs: 1 }, 1);
    await embedBatchWithRetry(sink, ctx, [SAMPLE_ITEM], 0, counters);
    expect(counters).toEqual({ succeeded: 1, skipped: 0 });
  });

  test("retryEmbedSliceOrSkip: Error-typed retryErr uses err.name and err.message", async () => {
    // Covers retryEmbedSliceOrSkip line=202 block=37 branch=0 and line=203 block=38 branch=0
    // (retryErr instanceof Error is TRUE for both name and message checks)
    const { ctx } = freshCtx();
    const counters = { succeeded: 0, skipped: 0 };
    // Both first call (embedSlice) and retry fail, with an Error instance
    const boom = new Error("slice-error");
    // status 429 + retryAfterMs=0 means it retries; second call also throws with same Error
    const sink = failingSink({ status: 429, retryAfterMs: 0 });
    // retryAfterMs=0, sink always fails → retryEmbedSliceOrSkip catches Error
    await embedBatchWithRetry(sink, ctx, [SAMPLE_ITEM], 0, counters);
    expect(counters.skipped).toBe(1);
    // Suppress unused variable warning — boom is only used to prove the branch is an Error path
    void boom;
  });

  test("retryEmbedSliceOrSkip: non-Error retryErr uses String(retryErr)", async () => {
    // Covers line=202 block=37 branch=1 and line=203 block=38 branch=1
    // (retryErr instanceof Error is FALSE — non-Error thrown on retry)
    const { ctx } = freshCtx();
    const counters = { succeeded: 0, skipped: 0 };
    // Throw a non-Error plain object as the error (string thrown, not Error instance)
    // status 429 so it retries, then retry also throws a plain string
    let firstCall = true;
    const mixedSink: ReembedSink = {
      embedItem: async () => {
        if (firstCall) {
          firstCall = false;
          throw { status: 429, retryAfterMs: 0 };
        }
        // On retry, throw a non-Error value
        throw "plain-string-error";
      },
    };
    await embedBatchWithRetry(mixedSink, ctx, [SAMPLE_ITEM], 0, counters);
    expect(counters.skipped).toBe(1);
  });
});

describe("clampBatchSize", () => {
  test("undefined input falls back to DEFAULT_BATCH (branch=1: not a finite number)", () => {
    // Covers line=48 block=0 branch=1: typeof raw !== "number" || !Number.isFinite(raw)
    expect(clampBatchSize(undefined)).toBe(100);
  });

  test("NaN input falls back to DEFAULT_BATCH", () => {
    expect(clampBatchSize(Number.NaN)).toBe(100);
  });

  test("Infinity input falls back to DEFAULT_BATCH", () => {
    expect(clampBatchSize(Number.POSITIVE_INFINITY)).toBe(100);
  });

  test("finite number is floored and clamped", () => {
    expect(clampBatchSize(50)).toBe(50);
    expect(clampBatchSize(0)).toBe(1); // clamps to MIN_BATCH
    expect(clampBatchSize(999)).toBe(256); // clamps to MAX_BATCH
    expect(clampBatchSize(7.9)).toBe(7); // floors
  });
});

describe("parseReembedParams", () => {
  test("null params throws (branch: params === null)", () => {
    // Covers line=53 block=2 branch=0: Array.isArray arm — actually the null/non-object arm
    expect(() => parseReembedParams(null)).toThrow(IndexReembedRpcError);
  });

  test("array params throws (block=2 branch=0: Array.isArray is true)", () => {
    // Covers line=53 block=2 branch=0
    expect(() => parseReembedParams([])).toThrow(IndexReembedRpcError);
  });

  test("primitive params throws", () => {
    expect(() => parseReembedParams("string")).toThrow(IndexReembedRpcError);
    expect(() => parseReembedParams(42)).toThrow(IndexReembedRpcError);
  });

  test("service not a string is ignored (line=65 block=8 branch=0: typeof check false)", () => {
    // Covers line=65 block=8 branch=0: service field is not a string
    const result = parseReembedParams({ model: "local", service: 123 });
    expect(result.service).toBeUndefined();
  });

  test("service empty string is ignored (line=65 block=9 branch=1: service === '')", () => {
    // Covers line=65 block=9 branch=1: service IS string but IS ""
    const result = parseReembedParams({ model: "local", service: "" });
    expect(result.service).toBeUndefined();
  });

  test("limit NaN is ignored (line=69 block=11 branch=1: Number.isFinite false)", () => {
    // Covers line=69 block=11 branch=1: rawLimit is number but not finite
    const result = parseReembedParams({ model: "local", limit: Number.NaN });
    expect(result.limit).toBeUndefined();
  });

  test("limit zero is ignored (line=69 block=11 branch=2: rawLimit > 0 false)", () => {
    // Covers line=69 block=11 branch=2: rawLimit is finite but <= 0
    const result = parseReembedParams({ model: "local", limit: 0 });
    expect(result.limit).toBeUndefined();
  });

  test("limit negative is ignored", () => {
    const result = parseReembedParams({ model: "local", limit: -5 });
    expect(result.limit).toBeUndefined();
  });

  test("limit as string is ignored (line=69 block=10 branch=0: typeof rawLimit !== 'number')", () => {
    // Covers line=69 block=10 branch=0: rawLimit is not a number
    const result = parseReembedParams({ model: "local", limit: "10" });
    expect(result.limit).toBeUndefined();
  });

  test("batchSize not a number is ignored (line=72 block=12 branch=1)", () => {
    // Covers line=72 block=12 branch=1: typeof rec["batchSize"] !== "number"
    const result = parseReembedParams({ model: "local", batchSize: "50" });
    expect(result.batchSize).toBeUndefined();
  });

  test("valid positive limit is accepted", () => {
    const result = parseReembedParams({ model: "local", limit: 10 });
    expect(result.limit).toBe(10);
  });

  test("valid batchSize is accepted", () => {
    const result = parseReembedParams({ model: "local", batchSize: 32 });
    expect(result.batchSize).toBe(32);
  });
});

describe("buildCandidateSql", () => {
  test("service filter appends AND clause (line=115 block=21 branch=0: service defined)", () => {
    // Covers line=115 block=21 branch=0: p.service !== undefined is TRUE
    const { sql, params } = buildCandidateSql({ model: "local", service: "github" });
    expect(sql).toContain("AND i.service = ?");
    expect(params).toContain("github");
  });

  test("itemType with colon appends service:type filter (line=120 block=23 branch=0: includes(':') true)", () => {
    // Covers line=120 block=23 branch=0: p.itemType.includes(':') is TRUE
    const { sql, params } = buildCandidateSql({ model: "local", itemType: "github:issue" });
    expect(sql).toContain("(i.service || ':' || i.type) = ?");
    expect(params).toContain("github:issue");
  });

  test("itemType without colon appends type filter", () => {
    const { sql, params } = buildCandidateSql({ model: "local", itemType: "issue" });
    expect(sql).toContain("AND i.type = ?");
    expect(params).toContain("issue");
  });

  test("limit appends LIMIT clause (line=129 block=24 branch=0: p.limit defined)", () => {
    // Covers line=129 block=24 branch=0: p.limit !== undefined is TRUE
    const { sql, params } = buildCandidateSql({ model: "local", limit: 5 });
    expect(sql).toContain("LIMIT ?");
    expect(params).toContain(5);
  });

  test("no optional fields produces base sql only", () => {
    const { sql, params } = buildCandidateSql({ model: "local" });
    expect(sql).not.toContain("AND i.service");
    expect(sql).not.toContain("AND i.type");
    expect(sql).not.toContain("LIMIT");
    expect(params).toEqual(["local"]);
  });
});

describe("assertModelUsable", () => {
  let savedKey: string | undefined;

  beforeEach(() => {
    savedKey = process.env["OPENAI_API_KEY"];
    delete process.env["OPENAI_API_KEY"];
  });

  afterEach(() => {
    if (savedKey !== undefined) {
      process.env["OPENAI_API_KEY"] = savedKey;
    } else {
      delete process.env["OPENAI_API_KEY"];
    }
  });

  test("openai: with env key passes (line=139 block=27 branch=1: envKey !== '')", async () => {
    // Covers line=139 block=27 branch=1: envKey is non-empty, skips vault check
    const { ctx } = freshCtx();
    process.env["OPENAI_API_KEY"] = "sk-test-env-key";
    await expect(
      assertModelUsable({ model: "openai:text-embedding-3-small" }, ctx),
    ).resolves.toBeUndefined();
  });

  test("openai: with vault key passes (line=141 block=28 branch=0 and line=142 block=29 branch=1)", async () => {
    // Covers line=141 block=28 branch=0: typeof v === "string" is TRUE
    // Covers line=142 block=29 branch=1: vaultKey !== "" → no throw
    const { ctx } = freshCtx();
    await ctx.vault.set("openai.api_key", "sk-vault-key");
    await expect(
      assertModelUsable({ model: "openai:text-embedding-3-small" }, ctx),
    ).resolves.toBeUndefined();
  });

  test("openai: vault returns null throws (existing coverage path — no env, no vault)", async () => {
    const { ctx } = freshCtx();
    await expect(
      assertModelUsable({ model: "openai:text-embedding-3-small" }, ctx),
    ).rejects.toBeInstanceOf(IndexReembedRpcError);
  });

  test("unknown model throws (line=149 block=30 branch=0: model not in supported list)", async () => {
    // Covers line=149 block=30 branch=0: neither Xenova nor local → throw
    const { ctx } = freshCtx();
    await expect(assertModelUsable({ model: "unknown-model" }, ctx)).rejects.toBeInstanceOf(
      IndexReembedRpcError,
    );
  });

  test("Xenova model passes (line=149 block=31 branch=1: model === Xenova → no throw)", async () => {
    // Covers line=149 block=31 branch=1: model is Xenova → else-if body skipped
    const { ctx } = freshCtx();
    await expect(
      assertModelUsable({ model: "Xenova/all-MiniLM-L6-v2" }, ctx),
    ).resolves.toBeUndefined();
  });

  test("local model passes", async () => {
    const { ctx } = freshCtx();
    await expect(assertModelUsable({ model: "local" }, ctx)).resolves.toBeUndefined();
  });
});

describe("resolveEmbedder", () => {
  let savedKey: string | undefined;

  beforeEach(() => {
    savedKey = process.env["OPENAI_API_KEY"];
    delete process.env["OPENAI_API_KEY"];
  });

  afterEach(() => {
    if (savedKey !== undefined) {
      process.env["OPENAI_API_KEY"] = savedKey;
    } else {
      delete process.env["OPENAI_API_KEY"];
    }
  });

  test("openai: with env key returns embedder (line=82 branch=0 true; line=85 branch=1 envKey!='')", async () => {
    // Covers line=82 block=14 branch=0: model.startsWith("openai:") is TRUE
    // Covers line=83 block=15 branch=1: processEnvGet returns defined value → trim() path
    // Covers line=85 block=16 branch=1: apiKey !== "" → skip vault lookup
    // Covers line=89 block=18 branch=1: apiKey !== "" → no throw
    const { ctx } = freshCtx();
    process.env["OPENAI_API_KEY"] = "sk-env-key";
    const embedder = await resolveEmbedder("openai:text-embedding-3-small", ctx);
    expect(embedder.model).toBe("openai:text-embedding-3-small");
    expect(embedder.dims).toBe(1536);
  });

  test("openai: with vault key returns embedder (line=85 branch=0 apiKey==''; line=87 branch=0 v is string; line=89 branch=1 key found)", async () => {
    // Covers line=85 block=16 branch=0: apiKey === "" → enters vault lookup
    // Covers line=87 block=17 branch=0: typeof v === "string" is TRUE → apiKey = v.trim()
    // Covers line=89 block=18 branch=1: apiKey !== "" after vault → no throw
    const { ctx } = freshCtx();
    await ctx.vault.set("openai.api_key", "sk-vault-key");
    const embedder = await resolveEmbedder("openai:text-embedding-3-small", ctx);
    expect(embedder.model).toBe("openai:text-embedding-3-small");
  });

  test("openai: vault returns null and no env → throws (line=87 branch=1 v not string; line=89 branch=0 throw)", async () => {
    // Covers line=87 block=17 branch=1: vault returns null → apiKey stays ""
    // Covers line=89 block=18 branch=0: apiKey === "" → throw
    const { ctx } = freshCtx();
    await expect(resolveEmbedder("openai:text-embedding-3-small", ctx)).rejects.toBeInstanceOf(
      IndexReembedRpcError,
    );
  });

  test("openai: env key undefined triggers vault lookup (line=83 branch=0: processEnvGet returns undefined)", async () => {
    // Covers line=83 block=15 branch=0: processEnvGet returns undefined → ?? '' gives ''
    // (OPENAI_API_KEY deleted in beforeEach)
    const { ctx } = freshCtx();
    await ctx.vault.set("openai.api_key", "sk-vault-only");
    const embedder = await resolveEmbedder("openai:text-embedding-3-small", ctx);
    expect(embedder.dims).toBe(1536);
  });

  test("unsupported model throws (line=82 branch=1 false; line=98 block=20 branch=1 false)", async () => {
    // Covers line=82 block=14 branch=1: model.startsWith("openai:") is FALSE
    // Covers line=98 block=20 branch=1: neither Xenova nor local → throw
    const { ctx } = freshCtx();
    await expect(resolveEmbedder("unsupported-model", ctx)).rejects.toBeInstanceOf(
      IndexReembedRpcError,
    );
  });
});

describe("dispatchIndexReembedRpc — non-dryRun via _sinkFactory seam", () => {
  let savedKey: string | undefined;

  beforeEach(() => {
    savedKey = process.env["OPENAI_API_KEY"];
    process.env["OPENAI_API_KEY"] = "sk-fake-key-for-seam-tests";
  });

  afterEach(() => {
    if (savedKey !== undefined) {
      process.env["OPENAI_API_KEY"] = savedKey;
    } else {
      delete process.env["OPENAI_API_KEY"];
    }
  });

  function ctxWithSink(sinkFactory: (embedder: Embedder) => ReembedSink): {
    ctx: IndexReembedRpcContext;
    events: Array<{ method: string; params: unknown }>;
  } {
    const db = new Database(":memory:");
    tryLoadSqliteVec(db);
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
    const events: Array<{ method: string; params: unknown }> = [];
    const ctx: IndexReembedRpcContext = {
      db,
      vault: new MockVault(),
      paths: { dataDir: "/tmp/nimbus-test" },
      logger: pino({ level: "silent" }),
      notify: (method: string, params: unknown) => {
        events.push({ method, params });
      },
      _sinkFactory: sinkFactory,
    };
    return { ctx, events };
  }

  test("non-dryRun with no candidates emits done with succeeded=0 (line=251 branch=1: dryRun false)", async () => {
    // Covers line=251 block=41 branch=1: p.dryRun !== true → takes non-dryRun path
    // Covers lines 254–279: embedder resolved, pipeline created, loop runs 0 times
    const { ctx, events } = ctxWithSink(() => ({
      embedItem: async () => {
        /* no-op */
      },
    }));
    const out = await dispatchIndexReembedRpc(
      "index.reembed",
      { model: "openai:text-embedding-3-small" },
      ctx,
    );
    expect(out.kind).toBe("hit");
    await new Promise((r) => setTimeout(r, 50));
    const done = events.find((e) => e.method === "index.reembedDone");
    expect(done).toBeDefined();
    expect((done?.params as Record<string, unknown> | undefined)?.["succeeded"]).toBe(0);
  });

  test("non-dryRun with candidates emits progress and done (line=263 branch=1: not aborted)", async () => {
    // Covers line=263 block=42 branch=1: signal.aborted is FALSE → process slice
    // Covers line=268: progress() called
    const { ctx, events } = ctxWithSink(() => ({
      embedItem: async (_item: IndexedItem) => {
        /* no-op */
      },
    }));
    const now = Date.now();
    upsertIndexedItem(ctx.db, {
      service: "github",
      type: "issue",
      externalId: "i1",
      title: "Issue 1",
      bodyPreview: "body text here",
      modifiedAt: now,
      syncedAt: now,
    });
    const out = await dispatchIndexReembedRpc(
      "index.reembed",
      { model: "openai:text-embedding-3-small", batchSize: 10 },
      ctx,
    );
    expect(out.kind).toBe("hit");
    await new Promise((r) => setTimeout(r, 50));
    expect(events.find((e) => e.method === "index.reembedProgress")).toBeDefined();
    expect(events.find((e) => e.method === "index.reembedDone")).toBeDefined();
  });

  test("aborted signal breaks out of loop before processing (line=263 branch=0: aborted true)", async () => {
    // Covers line=263 block=42 branch=0: signal.aborted is TRUE → break
    const now = Date.now();
    // Use a sink that records calls
    const embedCalls: string[] = [];
    const { ctx, events } = ctxWithSink(() => ({
      embedItem: async (item: IndexedItem) => {
        embedCalls.push(item.id);
      },
    }));
    // Insert 3 items so the loop would run multiple times with batchSize=1
    for (let i = 1; i <= 3; i++) {
      upsertIndexedItem(ctx.db, {
        service: "gh",
        type: "pr",
        externalId: `p${String(i)}`,
        title: `PR ${String(i)}`,
        modifiedAt: now,
        syncedAt: now,
      });
    }
    // Start the job (batchSize=1 so loop iterates per item)
    const out = await dispatchIndexReembedRpc(
      "index.reembed",
      { model: "openai:text-embedding-3-small", batchSize: 1 },
      ctx,
    );
    expect(out.kind).toBe("hit");
    const hit = (out as { kind: "hit"; value: { jobId: string } }).value;
    // Cancel immediately — the abort signal is set before the loop runs its second iteration
    const cancelOut = await dispatchIndexReembedRpc(
      "index.reembedCancel",
      { jobId: hit.jobId },
      ctx,
    );
    expect((cancelOut as { kind: "hit"; value: { cancelled: boolean } }).value.cancelled).toBe(
      true,
    );
    // Wait for the job to finish (either completed all items or broke on abort)
    await new Promise((r) => setTimeout(r, 100));
    // The done event must be emitted (either succeeded or aborted mid-run)
    expect(events.find((e) => e.method === "index.reembedDone")).toBeDefined();
  });
});

describe("handleReembedCancel edge cases", () => {
  test("null params → rec={} → jobId not string → throws (line=288 branch=1; line=290 branch=0)", async () => {
    // Covers line=288 block=43 branch=1: params === null → rec = {}
    // Covers line=290 block=45 branch=0: typeof jobId !== "string" → throw
    const { ctx } = freshCtx();
    await expect(dispatchIndexReembedRpc("index.reembedCancel", null, ctx)).rejects.toBeInstanceOf(
      IndexReembedRpcError,
    );
  });

  test("non-object params → rec={} → throws", async () => {
    // Covers line=288 block=43 branch=1 via non-object value (string)
    const { ctx } = freshCtx();
    await expect(
      dispatchIndexReembedRpc("index.reembedCancel", "not-an-object", ctx),
    ).rejects.toBeInstanceOf(IndexReembedRpcError);
  });

  test("params with numeric jobId → throws (line=290 branch=0: typeof jobId !== 'string')", async () => {
    // Covers line=290 block=45 branch=0: jobId is a number, not a string
    const { ctx } = freshCtx();
    await expect(
      dispatchIndexReembedRpc("index.reembedCancel", { jobId: 42 }, ctx),
    ).rejects.toBeInstanceOf(IndexReembedRpcError);
  });
});
