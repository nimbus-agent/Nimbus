import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FeatureExtractionPipe } from "./load-feature-extraction-pipeline.ts";
import { createLocalEmbedder, LOCAL_EMBEDDING_MODEL_ID, MINIMUM_MODEL_VERSION } from "./model.ts";

// Real, unique temp root for the fake cache dir (S5443). The loader is a fake — the
// cacheDir is only stored/asserted, never written.
const CACHE_DIR = mkdtempSync(join(tmpdir(), "nimbus-embedding-model-test-"));

type FakeTensor = { data: Float32Array; dims: readonly number[] };
type LoaderState = {
  tensor: FakeTensor;
  calls: Array<{ texts: string[]; options: unknown }>;
  cacheDir?: string;
};

function fakeLoader(state: LoaderState): (cacheDir: string) => Promise<FeatureExtractionPipe> {
  return async (cacheDir: string) => {
    state.cacheDir = cacheDir;
    return async (texts: string[], options: unknown) => {
      state.calls.push({ texts, options });
      return state.tensor;
    };
  };
}

afterEach(() => {
  delete process.env["NIMBUS_EMBEDDING_MODEL_DIR"];
});

describe("model.ts constants", () => {
  test("LOCAL_EMBEDDING_MODEL_ID and MINIMUM_MODEL_VERSION", () => {
    expect(LOCAL_EMBEDDING_MODEL_ID).toBe("all-MiniLM-L6-v2");
    expect(MINIMUM_MODEL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("createLocalEmbedder", () => {
  test("uses options.cacheDir and embeds rows", async () => {
    const state: LoaderState = {
      tensor: { data: new Float32Array([0.5, 0.25]), dims: [1, 2] },
      calls: [] as Array<{ texts: string[]; options: unknown }>,
    };
    const e = await createLocalEmbedder({ cacheDir: CACHE_DIR }, fakeLoader(state));
    expect(e.model).toBe("all-MiniLM-L6-v2");
    expect(e.dims).toBe(384);
    expect(state.cacheDir).toBe(CACHE_DIR);

    expect(await e.embed([])).toEqual([]);
    expect(state.calls.length).toBe(0);

    const out = await e.embed(["hi"]);
    expect(out.length).toBe(1);
    expect(Array.from(out[0] ?? [])).toEqual([0.5, 0.25]);
    expect(state.calls.at(-1)?.options).toEqual({ pooling: "mean", normalize: true });
  });

  test("NIMBUS_EMBEDDING_MODEL_DIR overrides the cache dir", async () => {
    process.env["NIMBUS_EMBEDDING_MODEL_DIR"] = "/override/dir";
    const state: LoaderState = {
      tensor: { data: new Float32Array([1]), dims: [1, 1] },
      calls: [] as Array<{ texts: string[]; options: unknown }>,
    };
    await createLocalEmbedder({ cacheDir: CACHE_DIR }, fakeLoader(state));
    expect(state.cacheDir).toBe("/override/dir");
  });

  test("tensorToRowVectors throws on a rank-1 tensor", async () => {
    const state: LoaderState = {
      tensor: { data: new Float32Array([1, 2]), dims: [2] }, // rank 1
      calls: [] as Array<{ texts: string[]; options: unknown }>,
    };
    const e = await createLocalEmbedder({ cacheDir: CACHE_DIR }, fakeLoader(state));
    await expect(e.embed(["x"])).rejects.toThrow(/Unexpected embedding tensor rank/);
  });

  test("NIMBUS_EMBEDDING_MODEL_DIR set to empty string falls back to options.cacheDir", async () => {
    process.env["NIMBUS_EMBEDDING_MODEL_DIR"] = "";
    const state: LoaderState = {
      tensor: { data: new Float32Array([1]), dims: [1, 1] },
      calls: [] as Array<{ texts: string[]; options: unknown }>,
    };
    await createLocalEmbedder({ cacheDir: CACHE_DIR }, fakeLoader(state));
    // empty string override is treated as absent → falls back to options.cacheDir
    expect(state.cacheDir).toBe(CACHE_DIR);
  });

  test("embed returns multiple row vectors for a batch tensor", async () => {
    // batch=2, width=3: data layout is [row0col0, row0col1, row0col2, row1col0, row1col1, row1col2]
    const state: LoaderState = {
      tensor: {
        data: new Float32Array([1, 2, 3, 4, 5, 6]),
        dims: [2, 3],
      },
      calls: [] as Array<{ texts: string[]; options: unknown }>,
    };
    const e = await createLocalEmbedder({ cacheDir: CACHE_DIR }, fakeLoader(state));
    const out = await e.embed(["hello", "world"]);
    expect(out.length).toBe(2);
    expect(Array.from(out[0] ?? [])).toEqual([1, 2, 3]);
    expect(Array.from(out[1] ?? [])).toEqual([4, 5, 6]);
  });

  test("tensorToRowVectors handles dims[0]=undefined (sparse) → treats as batch=0", async () => {
    // Create a sparse array of length 2 where index 0 is a hole (undefined at runtime)
    // This exercises the `dims[0] ?? 0` nullish branch.
    // Build the index-0 hole without a sparse-array literal (biome noSparseArray).
    const sparseWithMissingFirst = Object.assign([] as number[], {
      1: 1,
      length: 2,
    }) as unknown as readonly number[];
    const state: LoaderState = {
      tensor: { data: new Float32Array([]), dims: sparseWithMissingFirst },
      calls: [] as Array<{ texts: string[]; options: unknown }>,
    };
    const e = await createLocalEmbedder({ cacheDir: CACHE_DIR }, fakeLoader(state));
    // batch falls back to 0, so loop runs 0 times → returns []
    const out = await e.embed(["x"]);
    expect(out).toEqual([]);
  });

  test("tensorToRowVectors handles dims[1]=undefined (sparse) → treats as width=0", async () => {
    // Create a sparse array of length 2 where index 1 is a hole (undefined at runtime).
    // Build via Object.assign so length is 2 but index 1 is absent.
    // This exercises the `dims[1] ?? 0` nullish branch.
    const dims = Object.assign([] as number[], { 0: 1, length: 2 }) as unknown as readonly number[];
    const state: LoaderState = {
      tensor: { data: new Float32Array([]), dims },
      calls: [] as Array<{ texts: string[]; options: unknown }>,
    };
    const e = await createLocalEmbedder({ cacheDir: CACHE_DIR }, fakeLoader(state));
    // width=0, so each slice is empty → one empty Float32Array
    const out = await e.embed(["x"]);
    expect(out.length).toBe(1);
    expect(Array.from(out[0] ?? [42])).toEqual([]);
  });
});
