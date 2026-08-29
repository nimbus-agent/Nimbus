import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Embedder } from "../embedding/types.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { listEgress } from "./egress-verify.ts";
import { wrapLedgeredEmbedder } from "./embedding-egress.ts";
import { EgressAppendFailedError } from "./model-egress.ts";

function fake(isLocal: boolean, calls: { n: number }): Embedder {
  return {
    model: isLocal ? "local:minilm" : "openai:text-embedding-3-small",
    dims: 384,
    isLocal,
    embed: async (texts: string[]) => {
      calls.n += 1;
      return texts.map(() => new Float32Array(384));
    },
  };
}

describe("wrapLedgeredEmbedder", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  });
  afterEach(() => db.close());

  test("a LOCAL embedder is returned UNCHANGED and appends nothing", async () => {
    // Identity, not a pass-through wrapper -- the same choice `wrapLedgeredProvider` makes.
    // A local embed makes no outbound request, so ledgering it would over-claim egress.
    const calls = { n: 0 };
    const inner = fake(true, calls);
    const wrapped = wrapLedgeredEmbedder(db, inner);
    expect(wrapped).toBe(inner);
    await wrapped.embed(["hello"]);
    expect(listEgress(db, {})).toHaveLength(0);
  });

  test("a REMOTE embedder appends exactly ONE row per batch", async () => {
    // Per BATCH, not per text: one HTTP request carries the whole array, and a row per text
    // would over-report outbound requests by the batch size.
    const calls = { n: 0 };
    const wrapped = wrapLedgeredEmbedder(db, fake(false, calls), () => 1_700_000_000_000);
    await wrapped.embed(["a", "b", "c"]);

    const rows = listEgress(db, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sourceType).toBe("model");
    expect(rows[0]?.destination).toBe("openai");
    expect(rows[0]?.method).toBe("embedding.embed");
    expect(rows[0]?.timestamp).toBe(1_700_000_000_000);
  });

  test("an EMPTY batch appends nothing -- no request is made", async () => {
    // `createOpenAIEmbedder` returns early on an empty array without calling fetch, so a row
    // here would record an outbound request that never happened.
    const calls = { n: 0 };
    const wrapped = wrapLedgeredEmbedder(db, fake(false, calls));
    await wrapped.embed([]);
    expect(listEgress(db, {})).toHaveLength(0);
  });

  test("fail-closed: an append failure aborts, and the delegate never runs", async () => {
    const calls = { n: 0 };
    const wrapped = wrapLedgeredEmbedder(db, fake(false, calls));
    db.close(); // make the append throw
    await expect(wrapped.embed(["x"])).rejects.toThrow(EgressAppendFailedError);
    expect(calls.n).toBe(0);
    db = new Database(":memory:"); // so afterEach can close something
  });

  test("model and dims proxy faithfully", async () => {
    const wrapped = wrapLedgeredEmbedder(db, fake(false, { n: 0 }));
    expect(wrapped.model).toBe("openai:text-embedding-3-small");
    expect(wrapped.dims).toBe(384);
    expect(wrapped.isLocal).toBe(false);
  });
});
