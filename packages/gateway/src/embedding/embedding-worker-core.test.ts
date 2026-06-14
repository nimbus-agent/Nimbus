import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EmbeddingWorkerCore,
  type EmbeddingWorkerPipeline,
  type EmbeddingWorkerSetup,
  type InitMsg,
  type InMsg,
  isInMsg,
} from "./embedding-worker-core.ts";
import type { IndexedItem } from "./types.ts";

// Tracks every real bun:sqlite DB we open so afterEach can close it (no handle leak).
// NOTE: do NOT mark these tests it.concurrent — this shared tracker assumes Bun's
// default sequential execution.
const openDbs: Database[] = [];

afterEach(() => {
  while (openDbs.length > 0) {
    const db = openDbs.pop();
    db?.close();
  }
});

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run(
    `CREATE TABLE item (
       id TEXT PRIMARY KEY,
       service TEXT,
       type TEXT,
       title TEXT,
       body_preview TEXT
     )`,
  );
  openDbs.push(db);
  return db;
}

const INIT_MSG: InitMsg = {
  type: "init",
  dbPath: ":memory:",
  cacheDir: join(tmpdir(), "cache"),
  toml: { chunkTokens: 256, chunkOverlapTokens: 32, backfillBatchSize: 50 },
};

type FakePipelineOptions = {
  embedTexts?: (texts: string[]) => Promise<Float32Array[]>;
  embedItem?: (item: IndexedItem) => Promise<void>;
  backfillAll?: (onProgress?: (done: number, total: number) => void) => Promise<void>;
};

function makePipeline(opts: FakePipelineOptions = {}): EmbeddingWorkerPipeline {
  return {
    embedTexts: opts.embedTexts ?? (async () => []),
    embedItem: opts.embedItem ?? (async () => {}),
    backfillAll: opts.backfillAll ?? (async () => {}),
  };
}

/**
 * Build a core and drive it to readiness deterministically: send `init`, then resolve
 * once the `backfill_done` post is observed (init's detached backfill has completed).
 */
async function initReadyCore(
  setup: EmbeddingWorkerSetup,
): Promise<{ core: EmbeddingWorkerCore; posts: unknown[] }> {
  const posts: unknown[] = [];
  let onBackfillDone: (() => void) | null = null;
  const backfillDone = new Promise<void>((resolve) => {
    onBackfillDone = resolve;
  });
  const core = new EmbeddingWorkerCore({
    sendToMain: (data: unknown) => {
      posts.push(data);
      if (
        typeof data === "object" &&
        data !== null &&
        (data as { type?: unknown }).type === "backfill_done"
      ) {
        onBackfillDone?.();
      }
    },
    setup,
  });
  core.handleMessage(INIT_MSG);
  await backfillDone;
  await core.idle();
  return { core, posts };
}

function postsOfType(posts: unknown[], type: string): Array<Record<string, unknown>> {
  return posts.filter(
    (p): p is Record<string, unknown> =>
      typeof p === "object" && p !== null && (p as { type?: unknown }).type === type,
  );
}

describe("EmbeddingWorkerCore", () => {
  it("init success posts ready, backfill_progress, and backfill_done(success:true)", async () => {
    const db = makeDb();
    const setup: EmbeddingWorkerSetup = async () => ({
      db,
      pipeline: makePipeline({
        backfillAll: async (onProgress) => {
          onProgress?.(1, 2);
          onProgress?.(2, 2);
        },
      }),
    });
    const { posts } = await initReadyCore(setup);

    expect(postsOfType(posts, "ready")).toHaveLength(1);
    const progress = postsOfType(posts, "backfill_progress");
    expect(progress).toHaveLength(2);
    expect(progress[0]).toEqual({ type: "backfill_progress", done: 1, total: 2 });
    expect(progress[1]).toEqual({ type: "backfill_progress", done: 2, total: 2 });
    expect(postsOfType(posts, "backfill_done")).toEqual([{ type: "backfill_done", success: true }]);
  });

  it("init where backfillAll throws posts ready then backfill_done(success:false)", async () => {
    const db = makeDb();
    const setup: EmbeddingWorkerSetup = async () => ({
      db,
      pipeline: makePipeline({
        backfillAll: async () => {
          throw new Error("backfill boom");
        },
      }),
    });
    const { posts } = await initReadyCore(setup);

    expect(postsOfType(posts, "ready")).toHaveLength(1);
    expect(postsOfType(posts, "backfill_done")).toEqual([
      { type: "backfill_done", success: false },
    ]);
  });

  it("init where setup throws posts init_error and stays not-ready", async () => {
    const posts: unknown[] = [];
    const setup: EmbeddingWorkerSetup = async () => {
      throw new Error("setup boom");
    };
    const core = new EmbeddingWorkerCore({
      sendToMain: (data) => posts.push(data),
      setup,
    });
    core.handleMessage(INIT_MSG);
    await core.idle();

    expect(postsOfType(posts, "init_error")).toEqual([
      { type: "init_error", message: "setup boom" },
    ]);
    expect(postsOfType(posts, "ready")).toHaveLength(0);

    // A subsequent embed_texts produces NO result (core stayed not-ready).
    core.handleMessage({ type: "embed_texts", id: "x", texts: ["hello"] });
    await core.idle();
    expect(postsOfType(posts, "embed_texts_result")).toHaveLength(0);
  });

  it("ignores embed_texts / embed_item before init (not-ready guard)", async () => {
    const posts: unknown[] = [];
    const setup: EmbeddingWorkerSetup = async () => ({
      db: makeDb(),
      pipeline: makePipeline(),
    });
    const core = new EmbeddingWorkerCore({
      sendToMain: (data) => posts.push(data),
      setup,
    });
    core.handleMessage({ type: "embed_texts", id: "a", texts: ["x"] });
    core.handleMessage({ type: "embed_item", itemId: "i1" });
    await core.idle();
    expect(posts).toHaveLength(0);
  });

  it("ignores an unknown/malformed message type on a ready core (no throw, no new post)", async () => {
    const db = makeDb();
    const setup: EmbeddingWorkerSetup = async () => ({ db, pipeline: makePipeline() });
    const { core, posts } = await initReadyCore(setup);
    const before = posts.length;

    expect(() => core.handleMessage({ type: "nope" } as unknown as InMsg)).not.toThrow();
    await core.idle();
    expect(posts.length).toBe(before);
  });

  it("embed_texts ok posts embed_texts_result with plain number-array vectors", async () => {
    const db = makeDb();
    const setup: EmbeddingWorkerSetup = async () => ({
      db,
      pipeline: makePipeline({
        embedTexts: async () => [new Float32Array([1, 2, 3]), new Float32Array([4, 5])],
      }),
    });
    const { core, posts } = await initReadyCore(setup);

    core.handleMessage({ type: "embed_texts", id: "req-1", texts: ["a", "b"] });
    await core.idle();

    const results = postsOfType(posts, "embed_texts_result");
    expect(results).toHaveLength(1);
    const r = results[0] as {
      type: string;
      id: string;
      ok: boolean;
      vectors: number[][];
    };
    expect(r.id).toBe("req-1");
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.vectors)).toBe(true);
    expect(Array.isArray(r.vectors[0])).toBe(true);
    expect(r.vectors).toEqual([
      [1, 2, 3],
      [4, 5],
    ]);
  });

  it("embed_texts error posts embed_texts_result ok:false with the error message", async () => {
    const db = makeDb();
    const setup: EmbeddingWorkerSetup = async () => ({
      db,
      pipeline: makePipeline({
        embedTexts: async () => {
          throw new Error("embed boom");
        },
      }),
    });
    const { core, posts } = await initReadyCore(setup);

    core.handleMessage({ type: "embed_texts", id: "req-err", texts: ["a"] });
    await core.idle();

    expect(postsOfType(posts, "embed_texts_result")).toEqual([
      { type: "embed_texts_result", id: "req-err", ok: false, error: "embed boom" },
    ]);
  });

  it("embed_item embeds a found row and skips a missing row (no throw)", async () => {
    const db = makeDb();
    db.run("INSERT INTO item (id, service, type, title, body_preview) VALUES (?, ?, ?, ?, ?)", [
      "i1",
      "github",
      "issue",
      "Title",
      "Body",
    ]);
    const embedded: IndexedItem[] = [];
    const setup: EmbeddingWorkerSetup = async () => ({
      db,
      pipeline: makePipeline({
        embedItem: async (item) => {
          embedded.push(item);
        },
      }),
    });
    const { core } = await initReadyCore(setup);

    core.handleMessage({ type: "embed_item", itemId: "i1" });
    core.handleMessage({ type: "embed_item", itemId: "missing" });
    await core.idle();

    expect(embedded).toHaveLength(1);
    expect(embedded[0]).toEqual({
      id: "i1",
      service: "github",
      type: "issue",
      title: "Title",
      body_preview: "Body",
    });
  });

  it("embed_item queue keeps draining after a failed task (queue not wedged, no unhandled rejection)", async () => {
    const db = makeDb();
    db.run("INSERT INTO item (id, service, type, title, body_preview) VALUES (?, ?, ?, ?, ?)", [
      "A",
      "s",
      "t",
      "TA",
      null,
    ]);
    db.run("INSERT INTO item (id, service, type, title, body_preview) VALUES (?, ?, ?, ?, ?)", [
      "B",
      "s",
      "t",
      "TB",
      null,
    ]);
    let firstCall = true;
    const embedded: string[] = [];
    const setup: EmbeddingWorkerSetup = async () => ({
      db,
      pipeline: makePipeline({
        embedItem: async (item) => {
          if (firstCall) {
            firstCall = false;
            throw new Error("first task boom");
          }
          embedded.push(item.id);
        },
      }),
    });
    const { core } = await initReadyCore(setup);

    let unhandled = false;
    const onUnhandled = () => {
      unhandled = true;
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      core.handleMessage({ type: "embed_item", itemId: "A" });
      core.handleMessage({ type: "embed_item", itemId: "B" });
      await core.idle();
      // give any pending microtasks a tick to surface an unhandled rejection
      await Bun.sleep(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(embedded).toEqual(["B"]); // B's embedItem ran — queue drained past A's failure
    expect(unhandled).toBe(false);
  });

  it("ignores a duplicate init (no re-init, no overlapping backfill)", async () => {
    const db = makeDb();
    let setupCalls = 0;
    const posts: unknown[] = [];
    let onBackfillDone: (() => void) | null = null;
    const backfillDone = new Promise<void>((resolve) => {
      onBackfillDone = resolve;
    });
    const core = new EmbeddingWorkerCore({
      sendToMain: (data) => {
        posts.push(data);
        if (
          typeof data === "object" &&
          data !== null &&
          (data as { type?: unknown }).type === "backfill_done"
        ) {
          onBackfillDone?.();
        }
      },
      setup: async () => {
        setupCalls += 1;
        return { db, pipeline: makePipeline() };
      },
    });
    core.handleMessage(INIT_MSG);
    core.handleMessage(INIT_MSG); // duplicate — must be ignored (initStarted guard)
    await backfillDone;
    await core.idle();

    expect(setupCalls).toBe(1);
    expect(postsOfType(posts, "ready")).toHaveLength(1);
    expect(postsOfType(posts, "backfill_done")).toHaveLength(1);
  });

  it("handleMessage(null) on a ready core posts nothing and does not throw", async () => {
    const db = makeDb();
    const setup: EmbeddingWorkerSetup = async () => ({ db, pipeline: makePipeline() });
    const { core, posts } = await initReadyCore(setup);
    const before = posts.length;

    expect(() => core.handleMessage(null)).not.toThrow();
    await core.idle();
    expect(posts.length).toBe(before);
  });

  it("handleMessage({type:'embed_item'}) missing itemId on a ready core posts nothing", async () => {
    const db = makeDb();
    const setup: EmbeddingWorkerSetup = async () => ({ db, pipeline: makePipeline() });
    const { core, posts } = await initReadyCore(setup);
    const before = posts.length;

    expect(() => core.handleMessage({ type: "embed_item" })).not.toThrow();
    await core.idle();
    expect(posts.length).toBe(before);
  });
});

describe("isInMsg", () => {
  it("rejects non-object / null / primitive inputs", () => {
    expect(isInMsg(null)).toBe(false);
    expect(isInMsg(undefined)).toBe(false);
    expect(isInMsg(42)).toBe(false);
    expect(isInMsg("x")).toBe(false);
    expect(isInMsg({})).toBe(false);
  });

  it("rejects an object with an unknown type", () => {
    expect(isInMsg({ type: "nope" })).toBe(false);
  });

  it("accepts a valid init message and rejects a malformed one", () => {
    expect(
      isInMsg({
        type: "init",
        dbPath: ":memory:",
        cacheDir: join(tmpdir(), "cache"),
        toml: { chunkTokens: 256, chunkOverlapTokens: 32, backfillBatchSize: 50 },
      }),
    ).toBe(true);
    // missing dbPath
    expect(
      isInMsg({
        type: "init",
        cacheDir: join(tmpdir(), "cache"),
        toml: { chunkTokens: 256, chunkOverlapTokens: 32, backfillBatchSize: 50 },
      }),
    ).toBe(false);
    // toml missing a numeric field
    expect(
      isInMsg({
        type: "init",
        dbPath: ":memory:",
        cacheDir: join(tmpdir(), "cache"),
        toml: { chunkTokens: 256, chunkOverlapTokens: 32 },
      }),
    ).toBe(false);
  });

  it("accepts a valid embed_texts message and rejects a malformed one", () => {
    expect(isInMsg({ type: "embed_texts", id: "x", texts: ["a", "b"] })).toBe(true);
    // non-string element in texts
    expect(isInMsg({ type: "embed_texts", id: "x", texts: ["a", 1] })).toBe(false);
    // sparse array (holes) — Array.prototype.every would skip them; the guard must reject
    expect(isInMsg({ type: "embed_texts", id: "x", texts: Array(2) })).toBe(false);
    // texts not an array
    expect(isInMsg({ type: "embed_texts", id: "x", texts: "a" })).toBe(false);
    // missing id
    expect(isInMsg({ type: "embed_texts", texts: ["a"] })).toBe(false);
  });

  it("accepts a valid embed_item message and rejects one missing itemId", () => {
    expect(isInMsg({ type: "embed_item", itemId: "i1" })).toBe(true);
    expect(isInMsg({ type: "embed_item" })).toBe(false);
  });
});
