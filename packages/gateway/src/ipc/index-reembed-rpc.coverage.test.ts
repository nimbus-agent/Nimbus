import { Database } from "bun:sqlite";
import { afterEach, describe, expect, jest, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { IndexedItem } from "../embedding/types.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { tryLoadSqliteVec } from "../index/sqlite-vec-load.ts";
import { MockVault } from "../vault/mock.ts";
import {
  dispatchIndexReembedRpc,
  embedBatchWithRetry,
  type IndexReembedRpcContext,
  parseReembedParams,
  type ReembedSink,
} from "./index-reembed-rpc.ts";

/**
 * Coverage for the reembed paths the main suite cannot reach without real time or a real model:
 * the 2 s FALLBACK retry delay (on a fake clock), the logged NAME and MESSAGE of an `Error` that
 * survives the retry, the params filters, and the production branch that builds a REAL
 * `SqliteEmbeddingPipeline` instead of the `_sinkFactory` test seam. Nothing here makes a network
 * call: the remote embedder is constructed but, with zero candidates, never asked to embed.
 */

const dbs: Database[] = [];
const realFetch = globalThis.fetch;
let savedOpenAiKey: string | undefined;
let envTouched = false;

afterEach(() => {
  jest.useRealTimers();
  globalThis.fetch = realFetch;
  for (const db of dbs.splice(0)) db.close();
  if (envTouched) {
    if (savedOpenAiKey === undefined) delete process.env["OPENAI_API_KEY"];
    else process.env["OPENAI_API_KEY"] = savedOpenAiKey;
    envTouched = false;
  }
});

const ITEM: IndexedItem = {
  id: "github:issue:1",
  service: "github",
  type: "issue",
  title: "Flaky build",
  body_preview: "details",
};

type Note = { method: string; params: Record<string, unknown> };

function makeCtx(lines: string[] = []): {
  ctx: IndexReembedRpcContext;
  notes: Note[];
  db: Database;
  vault: MockVault;
  settled: Promise<Note>;
} {
  const db = new Database(":memory:");
  dbs.push(db);
  tryLoadSqliteVec(db);
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  const notes: Note[] = [];
  let resolveSettled: (n: Note) => void = () => {};
  const settled = new Promise<Note>((resolve) => {
    resolveSettled = resolve;
  });
  const vault = new MockVault();
  const ctx: IndexReembedRpcContext = {
    db,
    vault,
    paths: { dataDir: join(tmpdir(), "nimbus-reembed-cov") },
    logger: pino(
      { level: "info" },
      {
        write: (s: string): void => {
          lines.push(s);
        },
      },
    ),
    notify: (method, params) => {
      const note = { method, params: params as Record<string, unknown> };
      notes.push(note);
      if (method === "index.reembedDone" || method === "index.reembedError") resolveSettled(note);
    },
  };
  return { ctx, notes, db, vault, settled };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/**
 * Yields microtasks until `done()` holds (bounded), never waiting on a timer. Under fake timers
 * bun's per-test timeout never fires, so awaiting work whose fake timer did not fire would hang the
 * whole test process; checking that it settled first turns that into a failure of this test.
 */
async function flushUntil(done: () => boolean): Promise<void> {
  for (let i = 0; i < 1_000 && !done(); i++) await Promise.resolve();
}

describe("parseReembedParams — filters", () => {
  test("non-empty itemType and service strings are kept verbatim", () => {
    expect(
      parseReembedParams({ model: "local", itemType: "github:pr", service: "github" }),
    ).toEqual({ model: "local", itemType: "github:pr", service: "github" });
  });

  test("an empty or non-string itemType is dropped", () => {
    expect(parseReembedParams({ model: "local", itemType: "" })).toEqual({ model: "local" });
    expect(parseReembedParams({ model: "local", itemType: 5 })).toEqual({ model: "local" });
  });
});

describe("embedBatchWithRetry — fallback delay and logged retry failures", () => {
  test("a retryable error without retryAfterMs waits the 2000 ms fallback before retrying", async () => {
    jest.useFakeTimers();
    const { ctx } = makeCtx();
    let calls = 0;
    const sink: ReembedSink = {
      embedItem: async () => {
        calls += 1;
        if (calls === 1) throw { status: 503 };
      },
    };
    const counters = { succeeded: 0, skipped: 0 };
    let finished = false;
    const run = embedBatchWithRetry(sink, ctx, [ITEM], 0, counters).then(() => {
      finished = true;
    });

    await flushMicrotasks();
    expect(calls).toBe(1);
    jest.advanceTimersByTime(1_999);
    await flushMicrotasks();
    expect(calls).toBe(1);
    expect(finished).toBe(false);

    jest.advanceTimersByTime(1);
    await flushUntil(() => finished);
    expect(finished).toBe(true);
    await run;
    expect(calls).toBe(2);
    expect(counters).toEqual({ succeeded: 1, skipped: 0 });
  });

  test("an Error that survives the retry is logged by name and message, then the slice is skipped", async () => {
    class RateLimitError extends Error {
      override name = "RateLimitError";
      readonly status = 429;
      readonly retryAfterMs = 0;
    }
    const lines: string[] = [];
    const { ctx } = makeCtx(lines);
    const sink: ReembedSink = {
      embedItem: async () => {
        throw new RateLimitError("slow down");
      },
    };
    const counters = { succeeded: 0, skipped: 0 };
    await embedBatchWithRetry(sink, ctx, [ITEM, ITEM], 7, counters);

    expect(counters).toEqual({ succeeded: 0, skipped: 2 });
    const warn = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((e) => e["msg"] === "reembed batch failed after retry; skipping");
    expect(warn).toMatchObject({
      errName: "RateLimitError",
      errMessage: "slow down",
      batchStart: 7,
      batchSize: 2,
    });
  });
});

describe("dispatchIndexReembedRpc — the production sink (no _sinkFactory)", () => {
  test("a remote model builds a real SqliteEmbeddingPipeline and finishes cleanly with nothing to embed", async () => {
    savedOpenAiKey = process.env["OPENAI_API_KEY"];
    envTouched = true;
    delete process.env["OPENAI_API_KEY"];
    // The embedder is real and holds a key, so the network is trapped: a regression that made it
    // embed would fail here instead of sending that key to the real endpoint.
    let networkCalls = 0;
    globalThis.fetch = (async () => {
      networkCalls += 1;
      throw new Error("network is off in this test");
    }) as unknown as typeof fetch;
    const { ctx, notes, db, vault, settled } = makeCtx();
    await vault.set("openai.api_key", "sk-test-not-a-real-key");

    const out = await dispatchIndexReembedRpc(
      "index.reembed",
      { model: "openai:text-embedding-3-small" },
      ctx,
    );
    expect(out.kind).toBe("hit");

    const final = await settled;
    expect(final.method).toBe("index.reembedDone");
    expect(final.params).toMatchObject({ succeeded: 0, skipped: 0 });
    expect(notes.filter((n) => n.method === "index.reembedError")).toEqual([]);
    // Zero candidates means the remote embedder was never asked for anything: no egress row.
    const egress = db.query("SELECT COUNT(*) AS n FROM egress_ledger").get() as { n: number };
    expect(egress.n).toBe(0);
    expect(networkCalls).toBe(0);
  });
});
