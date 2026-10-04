/**
 * Arms of the in-process (lazy) embedding runtime that `lazy-scheduler.test.ts` leaves unexercised:
 * a v6+ schema on a connection that cannot load sqlite-vec, a warm-up that fails with a non-Error,
 * a backfill that cannot even start, an embed that yields no vector, and the
 * `[embedding] pause_on_battery` gate — consulted per page, a throwing gate failing only the pass,
 * and a terminated runtime short-circuiting the gate without consulting it.
 *
 * Connection failures are injected on ONE real `Database` instance (its own `query` /
 * `loadExtension`), never on the module or the prototype, so nothing leaks past the test.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import pino, { type Logger } from "pino";
import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { isVecLoaded, resetVecLoadFailureForTest } from "../index/sqlite-vec-load.ts";
import type { EmbeddingRuntime } from "./embedding-runtime.ts";
import { createLazyEmbeddingRuntime } from "./lazy-scheduler.ts";
import type { Embedder } from "./types.ts";

// The runtime only names `<dataDir>/models` for a model download; a preloaded embedder means
// nothing is ever written there.
const DATA_DIR = "unused-data-dir";
const TOML = { chunkTokens: 200, chunkOverlapTokens: 20, backfillBatchSize: 1 };

// Bun 1.3 never fires a test's timeout while the event loop is otherwise idle, so a regression that
// left an awaited embed pending would hang the WHOLE run instead of failing one test. A no-op
// interval keeps the loop alive so the per-test timeout can fire.
let keepAlive: ReturnType<typeof setInterval> | undefined;

beforeEach(() => {
  keepAlive = setInterval(() => {}, 1_000);
});

afterEach(() => {
  clearInterval(keepAlive);
  resetVecLoadFailureForTest();
});

function migratedDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

const VEC_AVAILABLE = ((): boolean => {
  const db = migratedDb();
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

function embedder(embed: Embedder["embed"]): Embedder {
  return { model: "local:test-minilm", dims: 384, isLocal: true, embed };
}

const unitVectors = embedder((texts) =>
  Promise.resolve(
    texts.map(() => {
      const v = new Float32Array(384);
      v[0] = 1;
      return v;
    }),
  ),
);

/** Replaces `query` on THIS connection only, delegating everything `refuse` does not answer. */
function interceptQuery(db: Database, refuse: (sql: string) => void): void {
  const realQuery = db.query.bind(db);
  db.query = ((sql: string) => {
    refuse(sql);
    return realQuery(sql);
  }) as unknown as Database["query"];
}

/** Yields to the event loop until `done()` holds, a bounded number of times — never a sleep. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
  if (!done()) throw new Error("condition never became true");
}

/**
 * Passed instead of leaving the factory to default to the REAL loader: with a preloaded embedder it
 * is never called, and if a regression ever did call it, the warm-up fails here on the spot — named
 * — instead of starting a real model download.
 */
const noModelLoad = (): Promise<Embedder> =>
  Promise.reject(new Error("unexpected model load: a preloaded embedder was supplied"));

function runtimeOn(
  db: Database,
  logger: Logger,
  emb: Embedder = unitVectors,
  backfillGate?: () => Promise<boolean>,
): EmbeddingRuntime {
  return createLazyEmbeddingRuntime(
    db,
    DATA_DIR,
    logger,
    TOML,
    emb,
    noModelLoad,
    backfillGate === undefined ? undefined : { backfillGate },
  );
}

describe("warm-up on a connection that cannot do the work", () => {
  test("a v6+ schema whose connection cannot load sqlite-vec settles unavailable, with the reason", async () => {
    const db = new Database(":memory:");
    db.run("PRAGMA user_version = 30");
    interceptQuery(db, (sql) => {
      if (sql.includes("vec_version")) throw new Error("no such function: vec_version");
    });
    db.loadExtension = (): void => {
      throw new Error("extension loading is disabled for this connection");
    };
    const { logger, msgs } = capturingLogger();
    const runtime = runtimeOn(db, logger);
    try {
      await until(() => runtime.getReadiness().state !== "warming");
      expect(runtime.getReadiness()).toMatchObject({
        state: "unavailable",
        reason: "sqlite-vec extension is unavailable",
      });
      expect(msgs).toEqual([
        "sqlite-vec unavailable; semantic embeddings disabled for this process",
      ]);
      // `unavailable` is permanent for this process, so a query answers null rather than throwing.
      expect(await runtime.embedQuery("checkout latency")).toBeNull();
    } finally {
      db.close();
    }
  });

  test("a warm-up that fails with a non-Error records that value as the reason", async () => {
    const db = migratedDb();
    interceptQuery(db, (sql) => {
      if (sql.startsWith("PRAGMA user_version")) throw "database is locked";
    });
    const { logger, msgs } = capturingLogger();
    const runtime = runtimeOn(db, logger);
    try {
      await until(() => runtime.getReadiness().state !== "warming");
      expect(runtime.getReadiness()).toMatchObject({
        state: "unavailable",
        reason: "database is locked",
      });
      // The backfill hits the same wall, and says it could not START — not that a pass failed.
      runtime.startBackgroundJobs();
      await until(() => msgs.length === 2);
      expect(msgs).toEqual([
        "embedding warm-up could not start",
        "embedding backfill could not start",
      ]);
    } finally {
      db.close();
    }
  });
});

describe.skipIf(!VEC_AVAILABLE)("a working pipeline", () => {
  test("an embed that yields no vector answers null for a single query", async () => {
    const db = migratedDb();
    const runtime = runtimeOn(
      db,
      pino({ level: "silent" }),
      embedder(() => Promise.resolve([])),
    );
    try {
      expect(await runtime.embedQuery("checkout latency")).toBeNull();
      expect(runtime.getReadiness().state).toBe("ready");
    } finally {
      db.close();
    }
  });
});

describe.skipIf(!VEC_AVAILABLE)("the backfill gate", () => {
  function seedItems(db: Database, n: number): void {
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

  test("is consulted before each page, and not at all once the runtime is terminated", async () => {
    const db = migratedDb();
    seedItems(db, 2);
    let gateCalls = 0;
    let releaseFirst: ((open: boolean) => void) | undefined;
    const runtime = runtimeOn(db, pino({ level: "silent" }), unitVectors, () => {
      gateCalls += 1;
      if (gateCalls === 1) return new Promise<boolean>((r) => (releaseFirst = r));
      return Promise.resolve(true);
    });
    try {
      runtime.startBackgroundJobs();
      await until(() => releaseFirst !== undefined);
      expect(embeddedItems(db)).toBe(0);

      runtime.terminate();
      releaseFirst?.(true);
      await until(
        () => runtime.getBackfillProgress()?.done === 1 && runtime.getActiveBackfillPass() === null,
      );
      // The admitted page was embedded; the next page check returned false without asking the
      // outer gate, so the second item was never reached.
      expect(gateCalls).toBe(1);
      expect(embeddedItems(db)).toBe(1);
      expect(runtime.getBackfillProgress()).toEqual({ done: 1, total: 2 });
    } finally {
      db.close();
    }
  });

  test("control: an open gate is asked once per page, and the pass embeds everything", async () => {
    const db = migratedDb();
    seedItems(db, 2);
    let gateCalls = 0;
    const runtime = runtimeOn(db, pino({ level: "silent" }), unitVectors, () => {
      gateCalls += 1;
      return Promise.resolve(true);
    });
    try {
      runtime.startBackgroundJobs();
      await until(() => embeddedItems(db) === 2 && runtime.getActiveBackfillPass() === null);
      // One check per one-item page, plus the check before the page that comes back empty.
      expect(gateCalls).toBe(3);
    } finally {
      db.close();
    }
  });

  test("a gate that throws fails the pass — logged as such — and the runtime stays ready", async () => {
    const db = migratedDb();
    seedItems(db, 1);
    const { logger, msgs } = capturingLogger();
    const runtime = runtimeOn(db, logger, unitVectors, () =>
      Promise.reject(new Error("power probe failed")),
    );
    try {
      runtime.startBackgroundJobs();
      await until(() => msgs.length > 0);
      expect(msgs).toEqual(["embedding backfill failed"]);
      expect(embeddedItems(db)).toBe(0);
      expect(runtime.getActiveBackfillPass()).toBeNull();
      expect(runtime.getReadiness().state).toBe("ready");
    } finally {
      db.close();
    }
  });
});
