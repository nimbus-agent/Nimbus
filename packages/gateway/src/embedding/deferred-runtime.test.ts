import { describe, expect, test } from "bun:test";

import { createDeferredEmbeddingRuntime } from "./deferred-runtime.ts";
import {
  EMBEDDING_WARMING_CODE,
  type EmbeddingReadiness,
  EmbeddingWarmingError,
  embedQueryBestEffort,
  embedQueryDualBestEffort,
  isEmbeddingWarmingError,
} from "./embedding-readiness.ts";
import type { EmbeddingRuntime } from "./embedding-runtime.ts";

function readiness(over: Partial<EmbeddingReadiness> = {}): EmbeddingReadiness {
  return {
    state: "ready",
    elapsedMs: 0,
    model: "fake-model",
    dims: 384,
    download: null,
    reason: null,
    ...over,
  };
}

type FakeOpts = {
  state?: EmbeddingReadiness["state"];
  vector?: Float32Array | null;
};

function fakeRuntime(opts: FakeOpts = {}): EmbeddingRuntime & {
  scheduled: string[];
  backgroundStarts: number;
  terminated: number;
} {
  const scheduled: string[] = [];
  let backgroundStarts = 0;
  let terminated = 0;
  const vec = opts.vector === undefined ? new Float32Array([1, 2, 3]) : opts.vector;
  const rt = {
    scheduled,
    get backgroundStarts(): number {
      return backgroundStarts;
    },
    get terminated(): number {
      return terminated;
    },
    scheduleItemEmbedding(itemId: string): void {
      scheduled.push(itemId);
    },
    async embedQuery(): Promise<Float32Array | null> {
      return vec;
    },
    async embedQueryDual(): Promise<{
      vec384: Float32Array | null;
      vec1536: Float32Array | null;
      model384: string | null;
      model1536: string | null;
    }> {
      return { vec384: vec, vec1536: null, model384: "fake-model", model1536: null };
    },
    getEmbeddingModel: () => "fake-model",
    getEmbeddingDims: () => 384,
    getBackfillProgress: () => ({ done: 2, total: 4 }),
    getReadiness: () => readiness({ state: opts.state ?? "ready" }),
    startBackgroundJobs(): void {
      backgroundStarts += 1;
    },
    terminate(): void {
      terminated += 1;
    },
  };
  return rt as unknown as EmbeddingRuntime & {
    scheduled: string[];
    backgroundStarts: number;
    terminated: number;
  };
}

/** An init that never settles — the cold-CDN fetch, made deterministic. */
function neverSettles(): Promise<EmbeddingRuntime | null> {
  return new Promise<EmbeddingRuntime | null>(() => {
    /* intentionally never resolves */
  });
}

function deferred(init: () => Promise<EmbeddingRuntime | null>): EmbeddingRuntime {
  return createDeferredEmbeddingRuntime({
    init,
    fallbackModel: "all-MiniLM-L6-v2",
    fallbackDims: 384,
  });
}

describe("createDeferredEmbeddingRuntime — bind-first (never blocks startup)", () => {
  test("returns a runtime SYNCHRONOUSLY even when init never settles", () => {
    let initCalled = false;
    const rt = deferred(() => {
      initCalled = true;
      return neverSettles();
    });
    // The factory is not async: the value exists on the same tick the caller asked for it.
    // This is the property that lets assemble.ts reach `ipc.start()` on a cold machine.
    expect(typeof rt.embedQuery).toBe("function");
    expect(initCalled).toBe(true);
    expect(rt.getReadiness().state).toBe("warming");
  });

  test("stays warming across many event-loop turns while init is in flight", async () => {
    const rt = deferred(neverSettles);
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
    await new Promise((r) => setTimeout(r, 10));
    expect(rt.getReadiness().state).toBe("warming");
    expect(rt.getReadiness().elapsedMs).toBeGreaterThanOrEqual(0);
  });

  test("a synchronous throw from init degrades to `unavailable`, it does not escape", async () => {
    const rt = deferred(() => {
      throw new Error("boom at construction");
    });
    await new Promise((r) => setTimeout(r, 5));
    const r = rt.getReadiness();
    expect(r.state).toBe("unavailable");
    expect(r.reason).toContain("boom at construction");
  });
});

describe("createDeferredEmbeddingRuntime — the false-green guard", () => {
  test("embedQuery THROWS EmbeddingWarmingError while warming; it never resolves null", async () => {
    const rt = deferred(neverSettles);
    let thrown: unknown;
    let resolved: unknown = "not-called";
    try {
      resolved = await rt.embedQuery("who owns billing?");
    } catch (err) {
      thrown = err;
    }
    // The guard: a null here is the false green — search would silently degrade to BM25
    // and a lexically-unmatched query would return [] as if nothing existed.
    expect(resolved).toBe("not-called");
    expect(isEmbeddingWarmingError(thrown)).toBe(true);
    expect((thrown as EmbeddingWarmingError).code).toBe(EMBEDDING_WARMING_CODE);
    expect((thrown as EmbeddingWarmingError).readiness.state).toBe("warming");
    expect((thrown as EmbeddingWarmingError).message).toContain("warming up");
  });

  test("embedQueryDual THROWS while warming; it never resolves the all-null shape", async () => {
    const rt = deferred(neverSettles);
    let thrown: unknown;
    let resolved: unknown = "not-called";
    try {
      resolved = await rt.embedQueryDual("who owns billing?");
    } catch (err) {
      thrown = err;
    }
    expect(resolved).toBe("not-called");
    expect(isEmbeddingWarmingError(thrown)).toBe(true);
  });

  test("warming propagates through a delegate that is itself still warming", async () => {
    const inner = fakeRuntime({ state: "warming" });
    const rt = deferred(async () => inner);
    await new Promise((r) => setTimeout(r, 5));
    expect(rt.getReadiness().state).toBe("warming");
    await expect(rt.embedQuery("q")).rejects.toBeInstanceOf(EmbeddingWarmingError);
  });

  test("the best-effort helpers are the ONLY way to get a null while warming", async () => {
    const rt = deferred(neverSettles);
    expect(await embedQueryBestEffort(rt, "q")).toBeNull();
    expect(await embedQueryDualBestEffort(rt, "q")).toEqual({
      vec384: null,
      vec1536: null,
      model384: null,
      model1536: null,
    });
  });

  test("best-effort helpers do NOT swallow real errors", async () => {
    const boom = new Error("sqlite exploded");
    const rt = {
      embedQuery: (): Promise<Float32Array | null> => Promise.reject(boom),
      embedQueryDual: (): Promise<never> => Promise.reject(boom),
    };
    await expect(embedQueryBestEffort(rt, "q")).rejects.toThrow("sqlite exploded");
    await expect(embedQueryDualBestEffort(rt, "q")).rejects.toThrow("sqlite exploded");
  });
});

describe("createDeferredEmbeddingRuntime — settled states", () => {
  test("init resolving null reports `disabled` and returns null (permanent, honest)", async () => {
    const rt = deferred(async () => null);
    await new Promise((r) => setTimeout(r, 5));
    expect(rt.getReadiness().state).toBe("disabled");
    expect(await rt.embedQuery("q")).toBeNull();
    expect(await rt.embedQueryDual("q")).toEqual({
      vec384: null,
      vec1536: null,
      model384: null,
      model1536: null,
    });
  });

  test("init rejecting reports `unavailable` with the reason and returns null", async () => {
    const rt = deferred(async () => {
      throw new Error("model fetch failed: ENOTFOUND huggingface.co");
    });
    await new Promise((r) => setTimeout(r, 5));
    const r = rt.getReadiness();
    expect(r.state).toBe("unavailable");
    expect(r.reason).toContain("ENOTFOUND");
    expect(await rt.embedQuery("q")).toBeNull();
  });

  test("a delegate that turns `unavailable` returns null, not a warming throw", async () => {
    const inner = fakeRuntime({ state: "unavailable" });
    const rt = deferred(async () => inner);
    await new Promise((r) => setTimeout(r, 5));
    expect(rt.getReadiness().state).toBe("unavailable");
    expect(await rt.embedQuery("q")).toBeNull();
  });

  test("once ready it delegates every method to the real runtime", async () => {
    const inner = fakeRuntime();
    const rt = deferred(async () => inner);
    await new Promise((r) => setTimeout(r, 5));
    expect(rt.getReadiness().state).toBe("ready");
    expect(await rt.embedQuery("q")).toEqual(new Float32Array([1, 2, 3]));
    expect((await rt.embedQueryDual("q")).model384).toBe("fake-model");
    expect(rt.getEmbeddingModel()).toBe("fake-model");
    expect(rt.getEmbeddingDims()).toBe(384);
    expect(rt.getBackfillProgress()).toEqual({ done: 2, total: 4 });
  });

  test("identity falls back to the configured model/dims before the delegate exists", () => {
    const rt = deferred(neverSettles);
    expect(rt.getEmbeddingModel()).toBe("all-MiniLM-L6-v2");
    expect(rt.getEmbeddingDims()).toBe(384);
    expect(rt.getBackfillProgress()).toBeNull();
    expect(rt.getReadiness().model).toBe("all-MiniLM-L6-v2");
  });

  test("elapsedMs freezes once the state settles", async () => {
    let t = 1000;
    const rt = createDeferredEmbeddingRuntime({
      init: async () => fakeRuntime(),
      fallbackModel: "m",
      fallbackDims: 384,
      nowMs: () => t,
    });
    t = 1500;
    await new Promise((r) => setTimeout(r, 5));
    expect(rt.getReadiness().elapsedMs).toBe(500);
    t = 9000;
    expect(rt.getReadiness().elapsedMs).toBe(500);
  });
});

describe("createDeferredEmbeddingRuntime — work queued while warming", () => {
  test("item ids scheduled while warming are replayed once the runtime arrives", async () => {
    let release: ((rt: EmbeddingRuntime | null) => void) | undefined;
    const inner = fakeRuntime();
    const rt = deferred(
      () =>
        new Promise<EmbeddingRuntime | null>((res) => {
          release = res;
        }),
    );
    rt.scheduleItemEmbedding("item-a");
    rt.scheduleItemEmbedding("item-b");
    expect(inner.scheduled).toEqual([]);
    release?.(inner);
    await new Promise((r) => setTimeout(r, 5));
    expect(inner.scheduled).toEqual(["item-a", "item-b"]);
    rt.scheduleItemEmbedding("item-c");
    expect(inner.scheduled).toEqual(["item-a", "item-b", "item-c"]);
  });

  test("the warm-up queue is bounded — the pipeline backfill covers the overflow", async () => {
    let release: ((rt: EmbeddingRuntime | null) => void) | undefined;
    const inner = fakeRuntime();
    const rt = createDeferredEmbeddingRuntime({
      init: () =>
        new Promise<EmbeddingRuntime | null>((res) => {
          release = res;
        }),
      fallbackModel: "m",
      fallbackDims: 384,
      maxQueuedItems: 2,
    });
    rt.scheduleItemEmbedding("a");
    rt.scheduleItemEmbedding("b");
    rt.scheduleItemEmbedding("c");
    release?.(inner);
    await new Promise((r) => setTimeout(r, 5));
    expect(inner.scheduled).toEqual(["a", "b"]);
  });

  test("scheduling is dropped (not queued) once the runtime is known to be disabled", async () => {
    const rt = deferred(async () => null);
    await new Promise((r) => setTimeout(r, 5));
    expect(() => {
      rt.scheduleItemEmbedding("x");
    }).not.toThrow();
  });

  test("startBackgroundJobs requested while warming fires exactly once on arrival", async () => {
    let release: ((rt: EmbeddingRuntime | null) => void) | undefined;
    const inner = fakeRuntime();
    const rt = deferred(
      () =>
        new Promise<EmbeddingRuntime | null>((res) => {
          release = res;
        }),
    );
    rt.startBackgroundJobs();
    rt.startBackgroundJobs();
    expect(inner.backgroundStarts).toBe(0);
    release?.(inner);
    await new Promise((r) => setTimeout(r, 5));
    expect(inner.backgroundStarts).toBe(1);
  });

  test("terminate before arrival still tears the late runtime down", async () => {
    let release: ((rt: EmbeddingRuntime | null) => void) | undefined;
    const inner = fakeRuntime();
    const rt = deferred(
      () =>
        new Promise<EmbeddingRuntime | null>((res) => {
          release = res;
        }),
    );
    rt.terminate();
    release?.(inner);
    await new Promise((r) => setTimeout(r, 5));
    expect(inner.terminated).toBe(1);
    // A terminated runtime never claims to be ready.
    expect(rt.getReadiness().state).not.toBe("ready");
    expect(await rt.embedQuery("q")).toBeNull();
  });

  test("terminate after arrival delegates and is idempotent", async () => {
    const inner = fakeRuntime();
    const rt = deferred(async () => inner);
    await new Promise((r) => setTimeout(r, 5));
    rt.terminate();
    rt.terminate();
    expect(inner.terminated).toBe(1);
  });

  test("startBackgroundJobs after arrival delegates immediately, once", async () => {
    const inner = fakeRuntime();
    const rt = deferred(async () => inner);
    await new Promise((r) => setTimeout(r, 5));
    rt.startBackgroundJobs();
    rt.startBackgroundJobs();
    expect(inner.backgroundStarts).toBe(1);
  });
});

describe("createDeferredEmbeddingRuntime — failure-reason shapes", () => {
  test("a non-Error rejection is still reported as a reason", async () => {
    const rt = deferred(() => Promise.reject("plain string failure"));
    await new Promise((r) => setTimeout(r, 5));
    expect(rt.getReadiness().reason).toBe("plain string failure");
  });

  test("an Error with an empty message falls back to its name", async () => {
    const rt = deferred(() => Promise.reject(new TypeError("")));
    await new Promise((r) => setTimeout(r, 5));
    expect(rt.getReadiness().reason).toBe("TypeError");
  });

  test("terminating an already-settled runtime keeps the settled state", async () => {
    const rt = deferred(async () => null);
    await new Promise((r) => setTimeout(r, 5));
    expect(rt.getReadiness().state).toBe("disabled");
    rt.terminate();
    expect(rt.getReadiness().state).toBe("disabled");
    // Scheduling against a terminated, settled runtime is inert.
    expect(() => {
      rt.scheduleItemEmbedding("x");
    }).not.toThrow();
  });

  test("onStateChange fires for each settled transition", async () => {
    const seen: string[] = [];
    const rt = createDeferredEmbeddingRuntime({
      init: async () => fakeRuntime(),
      fallbackModel: "m",
      fallbackDims: 384,
      onStateChange: (r) => seen.push(r.state),
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual(["ready"]);
    expect(rt.getReadiness().state).toBe("ready");
  });
});
