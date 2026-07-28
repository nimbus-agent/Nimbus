import { beforeEach, describe, expect, test } from "bun:test";

import type { Embedder } from "../../embedding/types.ts";
import {
  resetEmbedderCacheForTest,
  runEmbeddingThroughputOnce,
} from "./bench-embedding-throughput.ts";

interface CallLog {
  texts: string[];
  beforeTimer: boolean;
}

function makeFakeEmbedder(perCallMs: number): {
  embedder: { model: string; dims: number; embed: (t: string[]) => Promise<Float32Array[]> };
  calls: CallLog[];
  startTime: number;
} {
  const calls: CallLog[] = [];
  const startTime = performance.now();
  let timerStarted = false;
  const embedder = {
    model: "fake-mini",
    dims: 384,
    async embed(texts: string[]): Promise<Float32Array[]> {
      calls.push({ texts: [...texts], beforeTimer: !timerStarted });
      if (calls.length === 1) {
        timerStarted = true;
      }
      await new Promise((r) => setTimeout(r, perCallMs));
      return texts.map(() => new Float32Array(384));
    },
  };
  return { embedder, calls, startTime };
}

describe("runEmbeddingThroughputOnce", () => {
  test("performs a warm-up embed before timing begins", async () => {
    const { embedder, calls } = makeFakeEmbedder(1);
    const samples = await runEmbeddingThroughputOnce({
      length: 50,
      batch: 8,
      embedder,
      totalItems: 16,
    });
    expect(samples).toHaveLength(1);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]?.beforeTimer).toBe(true);
    expect(calls[0]?.texts).toHaveLength(1);
  });

  test("returns items/sec across the timed window", async () => {
    const { embedder } = makeFakeEmbedder(2);
    const samples = await runEmbeddingThroughputOnce({
      length: 50,
      batch: 8,
      embedder,
      totalItems: 16,
    });
    expect(samples[0]).toBeGreaterThan(0);
    expect(samples[0]).toBeLessThan(20_000);
  });

  test("calls embed in batches of `batch`", async () => {
    const { embedder, calls } = makeFakeEmbedder(0);
    await runEmbeddingThroughputOnce({
      length: 50,
      batch: 8,
      embedder,
      totalItems: 32,
    });
    expect(calls).toHaveLength(5);
    expect(calls[0]?.texts).toHaveLength(1);
    for (let i = 1; i < calls.length; i += 1) {
      expect(calls[i]?.texts).toHaveLength(8);
    }
  });

  test("scales totalItems to 10 × batch when corpus is 'small'", async () => {
    const { embedder, calls } = makeFakeEmbedder(0);
    await runEmbeddingThroughputOnce({
      length: 50,
      batch: 8,
      corpus: "small",
      embedder,
    });
    expect(calls).toHaveLength(11);
  });

  test("scales totalItems to 100 × batch when corpus is 'medium'", async () => {
    const { embedder, calls } = makeFakeEmbedder(0);
    await runEmbeddingThroughputOnce({
      length: 50,
      batch: 1,
      corpus: "medium",
      embedder,
    });
    expect(calls).toHaveLength(101);
  });

  test("preserves the canonical 1000 × batch default when corpus is unset", async () => {
    const { embedder, calls } = makeFakeEmbedder(0);
    await runEmbeddingThroughputOnce({
      length: 50,
      batch: 1,
      embedder,
    });
    expect(calls).toHaveLength(1001);
  }, 30_000);

  test("explicit totalItems overrides the corpus-derived default", async () => {
    const { embedder, calls } = makeFakeEmbedder(0);
    await runEmbeddingThroughputOnce({
      length: 50,
      batch: 8,
      corpus: "small",
      totalItems: 16,
      embedder,
    });
    expect(calls).toHaveLength(3);
  });
});

// The 12 S8 cells (l{50|500|5000} × b{1|8|32|64}) each call this surface. Run
// 30300911723 blew the 45-minute bench job because each cell independently
// re-resolved the MiniLM weights against an unreachable huggingface.co and paid
// the full ~6m45s failure ladder — 12 × that is ~81 min of dead wall-clock. The
// load is now memoised per cache dir so the model is resolved exactly once per
// process, success or failure.
describe("runEmbeddingThroughputOnce — shared model load", () => {
  beforeEach(() => {
    resetEmbedderCacheForTest();
  });

  function countingFactory(): {
    createEmbedder: (cacheDir: string) => Promise<Embedder>;
    dirs: string[];
  } {
    const dirs: string[] = [];
    return {
      dirs,
      createEmbedder: async (cacheDir: string): Promise<Embedder> => {
        dirs.push(cacheDir);
        return {
          model: "fake-mini",
          dims: 384,
          embed: async (texts: string[]): Promise<Float32Array[]> =>
            texts.map(() => new Float32Array(384)),
        };
      },
    };
  }

  test("resolves the model once across cells sharing a cache dir", async () => {
    const { createEmbedder, dirs } = countingFactory();
    for (const batch of [1, 8, 32] as const) {
      await runEmbeddingThroughputOnce({
        length: 50,
        batch,
        totalItems: 8,
        cacheDir: "/models",
        createEmbedder,
      });
    }
    expect(dirs).toEqual(["/models"]);
  });

  test("resolves separately per distinct cache dir", async () => {
    const { createEmbedder, dirs } = countingFactory();
    for (const cacheDir of ["/models-a", "/models-b"]) {
      await runEmbeddingThroughputOnce({
        length: 50,
        batch: 8,
        totalItems: 8,
        cacheDir,
        createEmbedder,
      });
    }
    expect(dirs).toEqual(["/models-a", "/models-b"]);
  });

  test("a failed model load is not retried by every subsequent cell", async () => {
    let attempts = 0;
    const createEmbedder = async (): Promise<Embedder> => {
      attempts += 1;
      throw new Error("Unable to connect. Is the computer able to access the url?");
    };
    for (let cell = 0; cell < 12; cell += 1) {
      await expect(
        runEmbeddingThroughputOnce({
          length: 50,
          batch: 8,
          totalItems: 8,
          cacheDir: "/models",
          createEmbedder,
        }),
      ).rejects.toThrow("Unable to connect");
    }
    expect(attempts).toBe(1);
  });

  test("an injected embedder bypasses the shared load entirely", async () => {
    const { createEmbedder, dirs } = countingFactory();
    const { embedder } = makeFakeEmbedder(0);
    await runEmbeddingThroughputOnce({
      length: 50,
      batch: 8,
      totalItems: 8,
      cacheDir: "/models",
      embedder,
      createEmbedder,
    });
    expect(dirs).toEqual([]);
  });
});
