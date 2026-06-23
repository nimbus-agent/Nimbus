import { describe, expect, test } from "bun:test";

import { runEmbeddingThroughputOnce } from "./bench-embedding-throughput.ts";

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
