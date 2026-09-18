import { afterEach, describe, expect, test } from "bun:test";

import {
  DEFAULT_EMBEDDING_QUERY_TIMEOUT_MS,
  describeEmbeddingWarming,
  downloadPercent,
  EMBEDDING_TIMEOUT_CODE,
  EMBEDDING_WARMING_CODE,
  EMBEDDING_WARMING_RPC_CODE,
  type EmbeddingReadiness,
  EmbeddingTimeoutError,
  EmbeddingWarmingError,
  embedQueryBestEffort,
  embedQueryDualBestEffort,
  embedQueryDualOutcome,
  isEmbeddingTimeoutError,
  isEmbeddingWarmingError,
  MAX_EMBEDDING_QUERY_TIMEOUT_MS,
  NO_DUAL_VECTORS,
  normalizeModelProgress,
  resolveEmbeddingQueryTimeoutMs,
  withEmbeddingQueryTimeout,
} from "./embedding-readiness.ts";

function readiness(over: Partial<EmbeddingReadiness> = {}): EmbeddingReadiness {
  return {
    state: "warming",
    elapsedMs: 0,
    model: null,
    dims: null,
    download: null,
    reason: null,
    ...over,
  };
}

describe("downloadPercent", () => {
  test("clamps to 0-100 and treats an unknown total as 0", () => {
    expect(downloadPercent(50, 200)).toBe(25);
    expect(downloadPercent(0, 0)).toBe(0);
    expect(downloadPercent(10, 0)).toBe(0);
    expect(downloadPercent(10, -5)).toBe(0);
    expect(downloadPercent(500, 100)).toBe(100);
    expect(downloadPercent(-5, 100)).toBe(0);
    expect(downloadPercent(Number.NaN, 100)).toBe(0);
    expect(downloadPercent(10, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("describeEmbeddingWarming", () => {
  test("names the model, the elapsed seconds, and the retry options", () => {
    const msg = describeEmbeddingWarming(
      readiness({ elapsedMs: 12_400, model: "all-MiniLM-L6-v2" }),
    );
    expect(msg).toContain("all-MiniLM-L6-v2");
    expect(msg).toContain("12s");
    expect(msg).toContain("warming up");
    expect(msg).toContain("without semantic search");
  });

  test("falls back to a generic model name and omits progress when unknown", () => {
    const msg = describeEmbeddingWarming(readiness());
    expect(msg).toContain("the local embedding model");
    expect(msg).not.toContain("downloading");
  });

  test("includes live download progress when the backend reports it", () => {
    const msg = describeEmbeddingWarming(
      readiness({
        download: { file: "model_quantized.onnx", loadedBytes: 3, totalBytes: 4, percent: 75 },
      }),
    );
    expect(msg).toContain("downloading model_quantized.onnx (75%)");
  });
});

describe("EmbeddingWarmingError", () => {
  test("carries the stable code, the readiness, and a descriptive message", () => {
    const r = readiness({ elapsedMs: 1_000, model: "m" });
    const err = new EmbeddingWarmingError(r);
    expect(err.name).toBe("EmbeddingWarmingError");
    expect(err.code).toBe(EMBEDDING_WARMING_CODE);
    expect(err.readiness).toEqual(r);
    expect(err.message).toContain("warming up");
    expect(err).toBeInstanceOf(Error);
  });

  test("the JSON-RPC code is a stable, documented constant", () => {
    expect(EMBEDDING_WARMING_RPC_CODE).toBe(-32021);
  });
});

describe("isEmbeddingWarmingError", () => {
  test("matches the real error", () => {
    expect(isEmbeddingWarmingError(new EmbeddingWarmingError(readiness()))).toBe(true);
  });

  test("matches a structurally-branded error from another module realm", () => {
    // The runtime crosses a Worker boundary; a duplicated module instance defeats
    // `instanceof`, so the brand has to be enough on its own.
    expect(isEmbeddingWarmingError({ code: EMBEDDING_WARMING_CODE })).toBe(true);
  });

  test("rejects everything else", () => {
    expect(isEmbeddingWarmingError(new Error("nope"))).toBe(false);
    expect(isEmbeddingWarmingError(null)).toBe(false);
    expect(isEmbeddingWarmingError(undefined)).toBe(false);
    expect(isEmbeddingWarmingError("embedding_warming")).toBe(false);
    expect(isEmbeddingWarmingError({ code: "something_else" })).toBe(false);
    expect(isEmbeddingWarmingError({})).toBe(false);
  });
});

describe("EmbeddingTimeoutError", () => {
  test("carries the stable code, the readiness, the budget, and a descriptive message", () => {
    const r = readiness({ state: "ready", model: "m" });
    const err = new EmbeddingTimeoutError(r, 5_000);
    expect(err.name).toBe("EmbeddingTimeoutError");
    expect(err.code).toBe(EMBEDDING_TIMEOUT_CODE);
    expect(err.readiness).toEqual(r);
    expect(err.timeoutMs).toBe(5_000);
    expect(err.message).toContain("5000ms");
    expect(err).toBeInstanceOf(Error);
  });

  test("is brand-checked across realms and never confused with the warming error", () => {
    expect(isEmbeddingTimeoutError(new EmbeddingTimeoutError(readiness(), 1))).toBe(true);
    expect(isEmbeddingTimeoutError({ code: EMBEDDING_TIMEOUT_CODE })).toBe(true);
    expect(isEmbeddingTimeoutError(new EmbeddingWarmingError(readiness()))).toBe(false);
    expect(isEmbeddingWarmingError(new EmbeddingTimeoutError(readiness(), 1))).toBe(false);
    expect(isEmbeddingTimeoutError(new Error("nope"))).toBe(false);
    expect(isEmbeddingTimeoutError(null)).toBe(false);
  });
});

describe("resolveEmbeddingQueryTimeoutMs", () => {
  const KEY = "NIMBUS_EMBEDDING_QUERY_TIMEOUT_MS";
  const saved = process.env[KEY];
  afterEach(() => {
    if (saved === undefined) {
      Reflect.deleteProperty(process.env, KEY);
    } else {
      process.env[KEY] = saved;
    }
  });

  test("defaults to 5 s — well inside the CLI's 30 s IPC bound, so the inner bound fires first", () => {
    Reflect.deleteProperty(process.env, KEY);
    expect(resolveEmbeddingQueryTimeoutMs()).toBe(DEFAULT_EMBEDDING_QUERY_TIMEOUT_MS);
    expect(DEFAULT_EMBEDDING_QUERY_TIMEOUT_MS).toBe(5_000);
  });

  test("honours a positive integer override and ignores anything else", () => {
    process.env[KEY] = "250";
    expect(resolveEmbeddingQueryTimeoutMs()).toBe(250);
    for (const bad of ["", "0", "-5", "abc", "1.5", "250ms", " 250"]) {
      process.env[KEY] = bad;
      expect(resolveEmbeddingQueryTimeoutMs()).toBe(DEFAULT_EMBEDDING_QUERY_TIMEOUT_MS);
    }
  });

  test("clamps an override below the IPC client's 30 s bound, so the inner bound still fires first", () => {
    expect(MAX_EMBEDDING_QUERY_TIMEOUT_MS).toBeLessThan(30_000);
    process.env[KEY] = "60000";
    expect(resolveEmbeddingQueryTimeoutMs()).toBe(MAX_EMBEDDING_QUERY_TIMEOUT_MS);
    process.env[KEY] = String(MAX_EMBEDDING_QUERY_TIMEOUT_MS);
    expect(resolveEmbeddingQueryTimeoutMs()).toBe(MAX_EMBEDDING_QUERY_TIMEOUT_MS);
  });
});

describe("withEmbeddingQueryTimeout", () => {
  test("resolves with the work's value when it settles in time", async () => {
    const out = await withEmbeddingQueryTimeout(Promise.resolve(7), {
      timeoutMs: 1_000,
      readiness: () => readiness({ state: "ready" }),
    });
    expect(out).toBe(7);
  });

  test("rejects with the TYPED timeout (never null) and runs the cleanup when the work stalls", async () => {
    let cleaned = 0;
    const never = new Promise<number>(() => {});
    const p = withEmbeddingQueryTimeout(never, {
      timeoutMs: 20,
      readiness: () => readiness({ state: "ready" }),
      onTimeout: () => {
        cleaned += 1;
      },
    });
    const err: unknown = await p.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isEmbeddingTimeoutError(err)).toBe(true);
    expect((err as EmbeddingTimeoutError).timeoutMs).toBe(20);
    expect(cleaned).toBe(1);
  });

  test("passes the work's own rejection through unchanged", async () => {
    await expect(
      withEmbeddingQueryTimeout(Promise.reject(new Error("boom")), {
        timeoutMs: 1_000,
        readiness: () => readiness({ state: "ready" }),
      }),
    ).rejects.toThrow("boom");
  });
});

describe("embedQueryDualOutcome", () => {
  const vec = new Float32Array([1]);

  test("reports no degradation for a real vector", async () => {
    const dual = { ...NO_DUAL_VECTORS, vec384: vec, model384: "m" };
    const out = await embedQueryDualOutcome({ embedQueryDual: async () => dual }, "q");
    expect(out.vectors).toBe(dual);
    expect(out.degraded).toBeNull();
  });

  test("names WHY the vectors are empty instead of discarding it", async () => {
    const warming = (): Promise<never> => {
      throw new EmbeddingWarmingError(readiness());
    };
    const timedOut = (): Promise<never> => {
      throw new EmbeddingTimeoutError(readiness({ state: "ready" }), 5);
    };
    const w = await embedQueryDualOutcome({ embedQueryDual: warming }, "q");
    expect(w).toEqual({ vectors: NO_DUAL_VECTORS, degraded: "warming" });
    const t = await embedQueryDualOutcome({ embedQueryDual: timedOut }, "q");
    expect(t).toEqual({ vectors: NO_DUAL_VECTORS, degraded: "timeout" });
  });

  test("rethrows anything that is not a known degradation", async () => {
    const broken = (): Promise<never> => {
      throw new Error("sqlite exploded");
    };
    await expect(embedQueryDualOutcome({ embedQueryDual: broken }, "q")).rejects.toThrow(
      "sqlite exploded",
    );
  });
});

describe("best-effort helpers", () => {
  test("also swallow the timeout — they are the sanctioned silent-degrade sites", async () => {
    const timedOut = (): Promise<never> => {
      throw new EmbeddingTimeoutError(readiness({ state: "ready" }), 5);
    };
    expect(await embedQueryBestEffort({ embedQuery: timedOut }, "q")).toBeNull();
    expect(await embedQueryDualBestEffort({ embedQueryDual: timedOut }, "q")).toEqual(
      NO_DUAL_VECTORS,
    );
  });

  test("pass a real vector straight through", async () => {
    const vec = new Float32Array([1]);
    expect(await embedQueryBestEffort({ embedQuery: async () => vec }, "q")).toBe(vec);
    const dual = { ...NO_DUAL_VECTORS, vec384: vec, model384: "m" };
    expect(await embedQueryDualBestEffort({ embedQueryDual: async () => dual }, "q")).toBe(dual);
  });

  test("convert ONLY the warming condition into the empty shape", async () => {
    const warming = (): Promise<never> => {
      throw new EmbeddingWarmingError(readiness());
    };
    expect(await embedQueryBestEffort({ embedQuery: warming }, "q")).toBeNull();
    expect(await embedQueryDualBestEffort({ embedQueryDual: warming }, "q")).toEqual(
      NO_DUAL_VECTORS,
    );
  });

  test("the returned empty shape is a COPY — callers cannot corrupt the shared constant", async () => {
    const warming = (): Promise<never> => {
      throw new EmbeddingWarmingError(readiness());
    };
    const out = await embedQueryDualBestEffort({ embedQueryDual: warming }, "q");
    out.model384 = "mutated";
    expect(NO_DUAL_VECTORS.model384).toBeNull();
  });
});

describe("normalizeModelProgress", () => {
  test("narrows a real @xenova progress event", () => {
    expect(
      normalizeModelProgress({
        status: "progress",
        file: "onnx/model_quantized.onnx",
        loaded: 1_000,
        total: 4_000,
        progress: 25,
      }),
    ).toEqual({
      file: "onnx/model_quantized.onnx",
      loadedBytes: 1_000,
      totalBytes: 4_000,
      percent: 25,
    });
  });

  test("derives the percent when the event omits it, and clamps a bogus one", () => {
    expect(
      normalizeModelProgress({ status: "progress", file: "f", loaded: 1, total: 2 })?.percent,
    ).toBe(50);
    expect(
      normalizeModelProgress({
        status: "progress",
        file: "f",
        loaded: 1,
        total: 2,
        progress: Number.NaN,
      })?.percent,
    ).toBe(50);
    expect(
      normalizeModelProgress({ status: "progress", file: "f", loaded: 1, total: 2, progress: 900 })
        ?.percent,
    ).toBe(100);
  });

  test("defaults missing fields rather than trusting the payload", () => {
    expect(normalizeModelProgress({ status: "progress" })).toEqual({
      file: "model",
      loadedBytes: 0,
      totalBytes: 0,
      percent: 0,
    });
  });

  test("ignores non-progress statuses and non-objects", () => {
    expect(normalizeModelProgress({ status: "done", file: "f" })).toBeNull();
    expect(normalizeModelProgress({ status: "initiate" })).toBeNull();
    expect(normalizeModelProgress(null)).toBeNull();
    expect(normalizeModelProgress("progress")).toBeNull();
    expect(normalizeModelProgress(undefined)).toBeNull();
  });
});
