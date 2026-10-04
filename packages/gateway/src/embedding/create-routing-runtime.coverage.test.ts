/**
 * Arms of the hybrid (MiniLM + OpenAI) runtime that `create-routing-runtime.test.ts` leaves
 * unexercised: the factory called with no deps bag at all, a NON-timeout failure in either half of
 * a dual query (it must propagate, never degrade to a partial), a stalled LOCAL half (the remote
 * vector survives, marked `local_timeout`), and the `[embedding] pause_on_battery` gate — consulted
 * by the backfill, and short-circuited without being consulted once the runtime is terminated.
 *
 * The OpenAI half is the real embedder over a stubbed `fetch`; nothing leaves the machine.
 */
import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino, { type Logger } from "pino";
import { requestUrl } from "../../test/helpers/request-url.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { isVecLoaded } from "../index/sqlite-vec-load.ts";
import type { PlatformPaths } from "../platform/paths.ts";
import { MockVault } from "../vault/mock.ts";
import { tryCreateRoutingEmbeddingRuntime } from "./create-routing-runtime.ts";
import { isEmbeddingTimeoutError } from "./embedding-readiness.ts";
import type { EmbeddingRuntime } from "./embedding-runtime.ts";
import type { Embedder } from "./types.ts";

const QUERY_KEY = "NIMBUS_EMBEDDING_QUERY_TIMEOUT_MS";
const DIR = mkdtempSync(join(tmpdir(), "nimbus-routing-runtime-cov-"));
const PATHS: PlatformPaths = {
  configDir: DIR,
  dataDir: DIR,
  logDir: DIR,
  socketPath: join(DIR, "gw.sock"),
  extensionsDir: join(DIR, "ext"),
  tempDir: DIR,
};
const TOML = { chunkTokens: 200, chunkOverlapTokens: 20, backfillBatchSize: 1 };
const REAL_FETCH = globalThis.fetch;
const saved = { openai: process.env["OPENAI_API_KEY"], query: process.env[QUERY_KEY] };

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}

// Bun 1.3 never fires a test's timeout while the event loop is otherwise idle (fake timers do not
// count), so a regression leaving an awaited embed pending would hang the WHOLE run instead of
// failing one test. A real no-op interval, created before any test fakes the clock, keeps the loop
// alive so the per-test timeout can fire.
let keepAlive: ReturnType<typeof setInterval> | undefined;

beforeEach(() => {
  keepAlive = setInterval(() => {}, 1_000);
  Reflect.deleteProperty(process.env, "OPENAI_API_KEY");
  Reflect.deleteProperty(process.env, QUERY_KEY);
});

afterEach(() => {
  jest.useRealTimers();
  clearInterval(keepAlive);
  globalThis.fetch = REAL_FETCH;
  restoreEnv("OPENAI_API_KEY", saved.openai);
  restoreEnv(QUERY_KEY, saved.query);
});

afterAll(() => {
  // Only ever named as the model cache path; the injected embedders never write under it.
  rmSync(DIR, { recursive: true, force: true });
});

function openDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

const VEC_AVAILABLE = ((): boolean => {
  const db = openDb();
  const ok = isVecLoaded(db);
  db.close();
  return ok;
})();

function capturingLogger(): { logger: Logger; msgs: string[] } {
  const msgs: string[] = [];
  const logger = pino(
    { level: "warn" },
    {
      write: (s: string): void => {
        msgs.push((JSON.parse(s) as { msg: string }).msg);
      },
    },
  );
  return { logger, msgs };
}

function localEmbedder(embed: Embedder["embed"]): () => Promise<Embedder> {
  return () => Promise.resolve({ model: "local:test-minilm", dims: 384, isLocal: true, embed });
}

const okLocal = localEmbedder((texts) =>
  Promise.resolve(
    texts.map(() => {
      const v = new Float32Array(384);
      v[0] = 1;
      return v;
    }),
  ),
);

/** Answers every OpenAI embeddings call; `status` other than 200 is an error response. */
function stubOpenAi(status = 200): { calls: () => number } {
  let calls = 0;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    if (!url.startsWith("https://api.openai.com/v1/embeddings")) {
      throw new Error(`unexpected fetch: ${url}`);
    }
    calls += 1;
    if (status !== 200) return Promise.resolve(new Response("quota exceeded", { status }));
    const { input: texts } = JSON.parse(String(init?.body)) as { input: string[] };
    const data = texts.map((_, index) => ({ index, embedding: new Array<number>(1536).fill(0.5) }));
    return Promise.resolve(Response.json({ data }));
  }) as unknown as typeof fetch;
  return { calls: () => calls };
}

async function keyedVault(): Promise<MockVault> {
  const vault = new MockVault();
  await vault.set("openai.api_key", "sk-test-not-real");
  return vault;
}

async function build(
  db: Database,
  createEmbedder: () => Promise<Embedder>,
  extra: { backfillGate?: () => Promise<boolean>; logger?: Logger } = {},
): Promise<EmbeddingRuntime> {
  const runtime = await tryCreateRoutingEmbeddingRuntime(
    db,
    PATHS,
    extra.logger ?? pino({ level: "silent" }),
    TOML,
    await keyedVault(),
    {
      createEmbedder,
      ...(extra.backfillGate === undefined ? {} : { backfillGate: extra.backfillGate }),
    },
  );
  if (runtime === null) throw new Error("expected a hybrid runtime");
  return runtime;
}

/** Yields to the event loop until `done()` holds, a bounded number of times — never a sleep. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
  if (!done()) throw new Error("condition never became true");
}

describe("tryCreateRoutingEmbeddingRuntime — no deps bag", () => {
  test("with no key anywhere it returns null and says why, before building any embedder", async () => {
    const db = openDb();
    const { logger, msgs } = capturingLogger();
    try {
      // No `deps` argument at all: the production defaults are selected, and the missing key
      // short-circuits before the real local embedder (a model download) is ever constructed.
      const runtime = await tryCreateRoutingEmbeddingRuntime(
        db,
        PATHS,
        logger,
        TOML,
        new MockVault(),
      );
      expect(runtime).toBeNull();
      expect(msgs).toEqual([
        "Hybrid embedding: openai.api_key missing; routing falls back to MiniLM-only",
      ]);
    } finally {
      db.close();
    }
  });
});

describe.skipIf(!VEC_AVAILABLE)("embedQueryDual — failures that are not timeouts", () => {
  test("a local half that fails outright rejects the whole query with its own error", async () => {
    const db = openDb();
    const openai = stubOpenAi();
    try {
      const runtime = await build(
        db,
        localEmbedder(() => Promise.reject(new Error("onnx session crashed"))),
      );
      await expect(runtime.embedQueryDual("checkout latency")).rejects.toThrow(
        "onnx session crashed",
      );
      // The remote half was really attempted — the rejection is not a short-circuit before it.
      expect(openai.calls()).toBe(1);
    } finally {
      db.close();
    }
  });

  test("a remote half that fails outright rejects the whole query, never a partial result", async () => {
    const db = openDb();
    stubOpenAi(429);
    try {
      const runtime = await build(db, okLocal);
      const outcome: unknown = await runtime.embedQueryDual("checkout latency").then(
        (v) => ({ resolved: v }),
        (e: unknown) => e,
      );
      expect(outcome).toBeInstanceOf(Error);
      expect(isEmbeddingTimeoutError(outcome)).toBe(false);
      expect((outcome as Error).message).toStartWith("OpenAI embeddings failed (429)");
    } finally {
      db.close();
    }
  });
});

describe.skipIf(!VEC_AVAILABLE)("embedQueryDual — a stalled local half (fake clock)", () => {
  test("keeps the remote vector, drops the local one, and marks the result local_timeout", async () => {
    const db = openDb();
    process.env[QUERY_KEY] = "50";
    stubOpenAi();
    try {
      const runtime = await build(
        db,
        localEmbedder(() => new Promise<Float32Array[]>(() => {})),
      );
      jest.useFakeTimers();
      // Settled into a variable and never awaited: with the clock faked, a query that never
      // settles would also never let the per-test timeout fire, and the whole run would hang.
      let settled: unknown;
      void runtime.embedQueryDual("checkout latency").then(
        (v) => {
          settled = v;
        },
        (e: unknown) => {
          settled = e;
        },
      );
      // Let the remote half finish (stub + in-memory ledger: no timer involved) before the clock
      // moves, so only the stalled local half is still waiting when its budget elapses.
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(settled).toBeUndefined();
      jest.advanceTimersByTime(50);
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(settled).toMatchObject({
        vec384: null,
        model384: null,
        model1536: "openai:text-embedding-3-small",
        partial: "local_timeout",
      });
      const vec1536 = (settled as { vec1536: Float32Array | null }).vec1536;
      expect(vec1536).toBeInstanceOf(Float32Array);
      expect(vec1536?.length).toBe(1536);
    } finally {
      db.close();
    }
  });
});

describe.skipIf(!VEC_AVAILABLE)("the backfill gate", () => {
  function seedLocalItems(db: Database, n: number): void {
    for (let i = 0; i < n; i++) {
      upsertIndexedItem(db, {
        service: "github",
        type: "pr",
        externalId: `acme/api#${String(i)}`,
        title: `Tune the retry budget ${String(i)}`,
        modifiedAt: 1_000 + i,
        syncedAt: 1_000 + i,
      });
    }
  }

  function embeddedItems(db: Database): number {
    return (
      db
        .query("SELECT COUNT(DISTINCT item_id) AS n FROM embedding_chunk WHERE model = ?")
        .get("local:test-minilm") as { n: number }
    ).n;
  }

  test("is consulted before each page, and stops being consulted once the runtime is terminated", async () => {
    const db = openDb();
    stubOpenAi();
    seedLocalItems(db, 2);
    let gateCalls = 0;
    let releaseSecond: ((open: boolean) => void) | undefined;
    const backfillGate = (): Promise<boolean> => {
      gateCalls += 1;
      // Call 1 is the OpenAI pass's only page check (no prose items to embed). Call 2 is the
      // local pass's first page — held open until the runtime has been terminated.
      if (gateCalls === 2) return new Promise<boolean>((r) => (releaseSecond = r));
      return Promise.resolve(true);
    };
    try {
      const runtime = await build(db, okLocal, { backfillGate });
      runtime.startBackgroundJobs();
      await until(() => releaseSecond !== undefined);
      expect(gateCalls).toBe(2);
      expect(embeddedItems(db)).toBe(0);

      runtime.terminate();
      releaseSecond?.(true);
      // Progress is reported per embedded item, so once one item is in, an inactive pass is a
      // SETTLED pass (before the first item there is no progress and `active` reads null anyway).
      await until(
        () => runtime.getBackfillProgress()?.done === 1 && runtime.getActiveBackfillPass() === null,
      );

      // The page already admitted was embedded; the next page check returned false WITHOUT
      // asking the outer gate, so the second item was never reached.
      expect(gateCalls).toBe(2);
      expect(embeddedItems(db)).toBe(1);
      expect(runtime.getBackfillProgress()).toEqual({ done: 1, total: 2 });
    } finally {
      db.close();
    }
  });

  test("control: a gate that stays open lets the backfill embed every item", async () => {
    const db = openDb();
    stubOpenAi();
    seedLocalItems(db, 2);
    let gateCalls = 0;
    try {
      const runtime = await build(db, okLocal, {
        backfillGate: () => {
          gateCalls += 1;
          return Promise.resolve(true);
        },
      });
      runtime.startBackgroundJobs();
      await until(() => embeddedItems(db) === 2 && runtime.getActiveBackfillPass() === null);
      // OpenAI pass: 1 check; local pass: one per page (2 items, batch size 1) plus the empty page.
      expect(gateCalls).toBe(4);
    } finally {
      db.close();
    }
  });
});
