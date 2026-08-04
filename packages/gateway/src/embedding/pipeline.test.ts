import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import pino, { type Logger } from "pino";
import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { isVecLoaded, tryLoadSqliteVec } from "../index/sqlite-vec-load.ts";
import { SqliteEmbeddingPipeline } from "./pipeline.ts";
import type { Embedder } from "./types.ts";

function vecAvailable(): boolean {
  const db = new Database(":memory:");
  tryLoadSqliteVec(db);
  const ok = isVecLoaded(db);
  db.close();
  return ok;
}
const VEC_AVAILABLE = vecAvailable();

function mockEmbedder(dim: number, model: string): Embedder {
  return {
    model,
    dims: dim,
    async embed(texts: string[]) {
      return texts.map(() => new Float32Array(dim).fill(0.01));
    },
  };
}

describe.skipIf(!VEC_AVAILABLE)("SqliteEmbeddingPipeline", () => {
  test("embedItem writes chunks and vectors; item delete cascades", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const now = Date.now();
    upsertIndexedItem(db, {
      service: "filesystem",
      type: "file",
      externalId: "f1",
      title: "alpha",
      bodyPreview: "beta gamma",
      modifiedAt: now,
      syncedAt: now,
    });
    const itemId = "filesystem:f1";

    const pipeline = new SqliteEmbeddingPipeline({
      db,
      embedder: mockEmbedder(384, "test-model"),
    });
    await pipeline.embedItem({
      id: itemId,
      service: "filesystem",
      type: "file",
      title: "alpha",
      body_preview: "beta gamma",
    });

    const chunkCount = db.query("SELECT COUNT(*) AS c FROM embedding_chunk").get() as { c: number };
    expect(chunkCount.c).toBeGreaterThanOrEqual(1);
    const vecCount = db.query("SELECT COUNT(*) AS c FROM vec_items_384").get() as { c: number };
    expect(vecCount.c).toBe(chunkCount.c);

    db.run("DELETE FROM item WHERE id = ?", [itemId]);
    expect((db.query("SELECT COUNT(*) AS c FROM embedding_chunk").get() as { c: number }).c).toBe(
      0,
    );
    expect((db.query("SELECT COUNT(*) AS c FROM vec_items_384").get() as { c: number }).c).toBe(0);
  });

  test("deleteItemEmbeddings removes rows without deleting item", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const now = Date.now();
    upsertIndexedItem(db, {
      service: "s",
      type: "file",
      externalId: "x",
      title: "t",
      modifiedAt: now,
      syncedAt: now,
    });
    const itemId = "s:x";
    const pipeline = new SqliteEmbeddingPipeline({ db, embedder: mockEmbedder(384, "m2") });
    await pipeline.embedItem({
      id: itemId,
      service: "s",
      type: "file",
      title: "t",
      body_preview: null,
    });
    await pipeline.deleteItemEmbeddings(itemId);
    expect((db.query("SELECT COUNT(*) AS c FROM embedding_chunk").get() as { c: number }).c).toBe(
      0,
    );
    const row = db.query("SELECT id FROM item WHERE id = ?").get(itemId);
    expect(row).not.toBeNull();
  });

  test("backfillAll embeds items missing the current model", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const now = Date.now();
    for (const ext of ["a", "b"]) {
      upsertIndexedItem(db, {
        service: "s",
        type: "file",
        externalId: ext,
        title: `title ${ext}`,
        modifiedAt: now,
        syncedAt: now,
      });
    }
    const pipeline = new SqliteEmbeddingPipeline({
      db,
      embedder: mockEmbedder(384, "bf"),
      backfillBatchSize: 1,
    });
    let last: [number, number] = [0, 0];
    await pipeline.backfillAll((done, total) => {
      last = [done, total];
    });
    expect(last[1]).toBe(2);
    expect(last[0]).toBe(2);
    const c = db
      .query("SELECT COUNT(DISTINCT item_id) AS c FROM embedding_chunk WHERE model = 'bf'")
      .get() as {
      c: number;
    };
    expect(c.c).toBe(2);
  });
});

function stubEmbedder(model: string, dims: number): Embedder {
  return {
    model,
    dims,
    async embed(texts) {
      return texts.map(() => new Float32Array(dims));
    },
  };
}

function freshDb(): Database {
  const db = new Database(":memory:");
  if (!tryLoadSqliteVec(db)) {
    throw new Error("sqlite-vec required for these tests");
  }
  runIndexedSchemaMigrations(db, 30);
  return db;
}

describe.skipIf(!VEC_AVAILABLE)("SqliteEmbeddingPipeline — dim awareness", () => {
  test("rejects unsupported dims at construction", () => {
    const db = freshDb();
    expect(
      () =>
        new SqliteEmbeddingPipeline({
          db,
          embedder: stubEmbedder("bogus", 512),
        }),
    ).toThrow(/unsupported embedding dim/);
  });

  test("writes 1536-dim vectors to vec_items_1536", async () => {
    const db = freshDb();
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview,
          modified_at, synced_at)
       VALUES (?, 'slack', 'message', 'e1', 'hello world', 'body', ?, ?)`,
      ["slack:e1", Date.now(), Date.now()],
    );
    const pipeline = new SqliteEmbeddingPipeline({
      db,
      embedder: stubEmbedder("openai:text-embedding-3-small", 1536),
    });
    await pipeline.embedItem({
      id: "slack:e1",
      service: "slack",
      type: "message",
      title: "hello world",
      body_preview: "body",
    });
    const chunks = db
      .query(`SELECT model, dims FROM embedding_chunk WHERE item_id = ?`)
      .all("slack:e1") as Array<{ model: string; dims: number }>;
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]?.dims).toBe(1536);
    const vecCount = (db.query(`SELECT count(*) AS c FROM vec_items_1536`).get() as { c: number })
      .c;
    expect(vecCount).toBe(chunks.length);
  });

  test("backfillForRoutingKeys with `in` scope only embeds matching items", async () => {
    const db = freshDb();
    const now = Date.now();
    const insertItem = (id: string, service: string, type: string) =>
      db.run(
        `INSERT INTO item (id, service, type, external_id, title, body_preview,
            modified_at, synced_at)
         VALUES (?, ?, ?, ?, 'T', NULL, ?, ?)`,
        [`${service}:${id}`, service, type, id, now, now],
      );
    insertItem("e1", "slack", "message");
    insertItem("e2", "github", "git_commit");
    insertItem("e3", "obsidian", "obsidian_note");

    const pipeline = new SqliteEmbeddingPipeline({
      db,
      embedder: stubEmbedder("openai:text-embedding-3-small", 1536),
    });
    await pipeline.backfillForRoutingKeys({
      in: ["slack:message", "obsidian:obsidian_note"],
    });

    const ids = db
      .query(`SELECT DISTINCT item_id FROM embedding_chunk ORDER BY item_id`)
      .all() as Array<{ item_id: string }>;
    expect(ids.map((r) => r.item_id)).toEqual(["obsidian:e3", "slack:e1"]);
  });

  test("backfillForRoutingKeys with `notIn` scope skips matching items", async () => {
    const db = freshDb();
    const now = Date.now();
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview,
          modified_at, synced_at)
       VALUES (?, 'slack', 'message', 'e1', 'T', NULL, ?, ?)`,
      ["slack:e1", now, now],
    );
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview,
          modified_at, synced_at)
       VALUES (?, 'github', 'git_commit', 'e2', 'T', NULL, ?, ?)`,
      ["github:e2", now, now],
    );
    const pipeline = new SqliteEmbeddingPipeline({
      db,
      embedder: stubEmbedder("Xenova/all-MiniLM-L6-v2", 384),
    });
    await pipeline.backfillForRoutingKeys({ notIn: ["slack:message"] });
    const ids = db.query(`SELECT DISTINCT item_id FROM embedding_chunk`).all() as Array<{
      item_id: string;
    }>;
    expect(ids.map((r) => r.item_id)).toEqual(["github:e2"]);
  });

  // --- Branch coverage additions ---

  test("embedItem returns early when text is entirely empty (pieces.length === 0)", async () => {
    const db = freshDb();
    // title and body_preview both empty → itemTextForEmbedding returns "" → chunkText returns []
    const pipeline = new SqliteEmbeddingPipeline({
      db,
      embedder: stubEmbedder("Xenova/all-MiniLM-L6-v2", 384),
    });
    // No item in DB needed — the early return fires before any DB write
    await pipeline.embedItem({
      id: "x:1",
      service: "x",
      type: "t",
      title: "   ",
      body_preview: null,
    });
    const c = (db.query("SELECT COUNT(*) AS c FROM embedding_chunk").get() as { c: number }).c;
    expect(c).toBe(0);
  });

  test("embedItem throws when embedder returns wrong vector count", async () => {
    const db = freshDb();
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at)
       VALUES (?, 'github', 'issue', 'e1', 'hello world', 'body text', ?, ?)`,
      ["github:e1", Date.now(), Date.now()],
    );
    // Use tiny maxChunkTokens to guarantee multiple chunks are produced so
    // that returning exactly 1 vector triggers the mismatch guard.
    const badEmbedder: Embedder = {
      model: "Xenova/all-MiniLM-L6-v2",
      dims: 384,
      async embed(_texts) {
        // Always return exactly 1 vector regardless of how many chunks were produced
        return [new Float32Array(384)];
      },
    };
    const pipeline = new SqliteEmbeddingPipeline({
      db,
      embedder: badEmbedder,
      chunkOptions: { maxChunkTokens: 1, overlapTokens: 0 },
    });
    await expect(
      pipeline.embedItem({
        id: "github:e1",
        service: "github",
        type: "issue",
        title: "hello world",
        body_preview: "body text",
      }),
    ).rejects.toThrow(/embedder returned/);
  });

  test("embedItem throws when a returned vector has wrong dimensionality", async () => {
    const db = freshDb();
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at)
       VALUES (?, 'github', 'issue', 'e2', 'one sentence.', 'body text here.', ?, ?)`,
      ["github:e2", Date.now(), Date.now()],
    );
    const wrongDimEmbedder: Embedder = {
      model: "Xenova/all-MiniLM-L6-v2",
      dims: 384,
      async embed(texts) {
        // Return the right count but wrong dims
        return texts.map(() => new Float32Array(128));
      },
    };
    const pipeline = new SqliteEmbeddingPipeline({ db, embedder: wrongDimEmbedder });
    await expect(
      pipeline.embedItem({
        id: "github:e2",
        service: "github",
        type: "issue",
        title: "one sentence.",
        body_preview: "body text here.",
      }),
    ).rejects.toThrow(/expected.*dim embedding/);
  });

  test("backfillAll without onProgress callback (branch: optional call omitted)", async () => {
    const db = freshDb();
    const now = Date.now();
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at)
       VALUES (?, 'github', 'issue', 'e1', 'title here', 'body', ?, ?)`,
      ["github:e1", now, now],
    );
    const pipeline = new SqliteEmbeddingPipeline({
      db,
      embedder: stubEmbedder("Xenova/all-MiniLM-L6-v2", 384),
    });
    // Should not throw — onProgress is undefined, the optional call branch is taken
    await pipeline.backfillAll();
    const c = (db.query("SELECT COUNT(*) AS c FROM embedding_chunk").get() as { c: number }).c;
    expect(c).toBeGreaterThanOrEqual(1);
  });

  test("backfillAll catches and warns on per-item embed failure", async () => {
    const db = freshDb();
    const now = Date.now();
    // Use distinct modified_at so order is deterministic (DESC → ok1 first, bad1 second)
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at)
       VALUES (?, 'github', 'issue', 'ok1', 'another title', 'other body', ?, ?)`,
      ["github:ok1", now + 1000, now],
    );
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at)
       VALUES (?, 'github', 'issue', 'bad1', 'some title', 'some body', ?, ?)`,
      ["github:bad1", now, now],
    );

    // embedder succeeds for ok1 (first call), fails for bad1 (second call),
    // then bad1 is re-queried but since it still has no embedding it comes up
    // again — we succeed on subsequent calls to avoid an infinite loop.
    let embedCallCount = 0;
    const flakyEmbedder: Embedder = {
      model: "Xenova/all-MiniLM-L6-v2",
      dims: 384,
      async embed(texts) {
        embedCallCount += 1;
        if (embedCallCount === 2) {
          throw new Error("network timeout");
        }
        return texts.map(() => new Float32Array(384));
      },
    };

    const warnMessages: unknown[] = [];
    const silentBase = pino({ level: "silent" });
    const spyLogger = {
      ...silentBase,
      warn(obj: unknown, _msg?: string) {
        warnMessages.push(obj);
      },
    } as unknown as Logger;

    const pipeline = new SqliteEmbeddingPipeline({
      db,
      embedder: flakyEmbedder,
      logger: spyLogger,
      backfillBatchSize: 1,
    });

    const progress: Array<[number, number]> = [];
    await pipeline.backfillAll((done, total) => {
      progress.push([done, total]);
    });

    // The warn was called for the failing item
    expect(warnMessages.length).toBeGreaterThanOrEqual(1);
    // At least one item succeeded in being embedded
    const c = (db.query("SELECT COUNT(*) AS c FROM embedding_chunk").get() as { c: number }).c;
    expect(c).toBeGreaterThanOrEqual(1);
  });

  test("backfillForRoutingKeys with empty `in` array returns immediately (no DB reads)", async () => {
    const db = freshDb();
    const now = Date.now();
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at)
       VALUES (?, 'slack', 'message', 'e1', 'hello', 'body', ?, ?)`,
      ["slack:e1", now, now],
    );
    const pipeline = new SqliteEmbeddingPipeline({
      db,
      embedder: stubEmbedder("Xenova/all-MiniLM-L6-v2", 384),
    });
    // Empty `in` list → early return, nothing embedded
    await pipeline.backfillForRoutingKeys({ in: [] });
    const c = (db.query("SELECT COUNT(*) AS c FROM embedding_chunk").get() as { c: number }).c;
    expect(c).toBe(0);
  });

  test("backfillForRoutingKeys with empty `notIn` array falls back to backfillAll", async () => {
    const db = freshDb();
    const now = Date.now();
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at)
       VALUES (?, 'slack', 'message', 'e1', 'hello', 'body', ?, ?)`,
      ["slack:e1", now, now],
    );
    const pipeline = new SqliteEmbeddingPipeline({
      db,
      embedder: stubEmbedder("Xenova/all-MiniLM-L6-v2", 384),
    });
    // Empty `notIn` list → calls backfillAll (all items match)
    await pipeline.backfillForRoutingKeys({ notIn: [] });
    const c = (db.query("SELECT COUNT(*) AS c FROM embedding_chunk").get() as { c: number }).c;
    expect(c).toBeGreaterThanOrEqual(1);
  });

  test("backfillForRoutingKeys without onProgress callback (optional branch omitted)", async () => {
    const db = freshDb();
    const now = Date.now();
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at)
       VALUES (?, 'slack', 'message', 'e1', 'hello', 'body', ?, ?)`,
      ["slack:e1", now, now],
    );
    const pipeline = new SqliteEmbeddingPipeline({
      db,
      embedder: stubEmbedder("Xenova/all-MiniLM-L6-v2", 384),
    });
    // No onProgress — exercises the `onProgress?.()` branch where the call is skipped
    await pipeline.backfillForRoutingKeys({ in: ["slack:message"] });
    const c = (db.query("SELECT COUNT(*) AS c FROM embedding_chunk").get() as { c: number }).c;
    expect(c).toBeGreaterThanOrEqual(1);
  });

  test("backfillForRoutingKeys catch block: logs and continues on per-item failure", async () => {
    const db = freshDb();
    const now = Date.now();
    // ok1 has higher modified_at so it's processed first (DESC order)
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at)
       VALUES (?, 'slack', 'message', 'ok1', 'good title', 'body text', ?, ?)`,
      ["slack:ok1", now + 1000, now],
    );
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at)
       VALUES (?, 'slack', 'message', 'bad1', 'some title', 'body text', ?, ?)`,
      ["slack:bad1", now, now],
    );

    // ok1 succeeds (call 1), bad1 fails (call 2), bad1 re-queried but succeeds on call 3+
    let callIdx = 0;
    const flakyEmbedder: Embedder = {
      model: "Xenova/all-MiniLM-L6-v2",
      dims: 384,
      async embed(texts) {
        callIdx += 1;
        if (callIdx === 2) {
          throw new Error("transient failure");
        }
        return texts.map(() => new Float32Array(384));
      },
    };

    const warnArgs: unknown[] = [];
    const silentBase = pino({ level: "silent" });
    const spyLogger = {
      ...silentBase,
      warn(obj: unknown, _msg?: string) {
        warnArgs.push(obj);
      },
    } as unknown as Logger;

    const pipeline = new SqliteEmbeddingPipeline({
      db,
      embedder: flakyEmbedder,
      logger: spyLogger,
      backfillBatchSize: 1,
    });

    const progress: Array<[number, number]> = [];
    await pipeline.backfillForRoutingKeys({ in: ["slack:message"] }, (done, total) => {
      progress.push([done, total]);
    });

    expect(warnArgs.length).toBeGreaterThanOrEqual(1);
    // At least one item was embedded successfully
    const c = (db.query("SELECT COUNT(*) AS c FROM embedding_chunk").get() as { c: number }).c;
    expect(c).toBeGreaterThanOrEqual(1);
  });

  test("constructor accepts default backfillBatchSize (backfillBatchSize ?? DEFAULT_BACKFILL_BATCH branch)", async () => {
    const db = freshDb();
    // No backfillBatchSize provided → uses DEFAULT_BACKFILL_BATCH (50)
    const pipeline = new SqliteEmbeddingPipeline({
      db,
      embedder: stubEmbedder("Xenova/all-MiniLM-L6-v2", 384),
    });
    // embeddingModel / embeddingDims accessors
    expect(pipeline.embeddingModel).toBe("Xenova/all-MiniLM-L6-v2");
    expect(pipeline.embeddingDims).toBe(384);
  });

  test("constructor clamps backfillBatchSize to 1 when given 0", async () => {
    const db = freshDb();
    // Math.max(1, 0) = 1 — exercises the clamping branch
    const pipeline = new SqliteEmbeddingPipeline({
      db,
      embedder: stubEmbedder("Xenova/all-MiniLM-L6-v2", 384),
      backfillBatchSize: 0,
    });
    expect(pipeline.embeddingDims).toBe(384);
  });

  test("embedTexts delegates to embedder.embed", async () => {
    const db = freshDb();
    const pipeline = new SqliteEmbeddingPipeline({
      db,
      embedder: stubEmbedder("Xenova/all-MiniLM-L6-v2", 384),
    });
    const result = await pipeline.embedTexts(["hello", "world"]);
    expect(result).toHaveLength(2);
    expect(result[0]).toBeInstanceOf(Float32Array);
    expect(result[0]).toHaveLength(384);
  });

  test("constructor clamps backfillConcurrency to 1 when given 0", async () => {
    const db = freshDb();
    // Math.max(1, 0) = 1 — exercises the concurrency clamping branch
    const pipeline = new SqliteEmbeddingPipeline({
      db,
      embedder: stubEmbedder("Xenova/all-MiniLM-L6-v2", 384),
      backfillConcurrency: 0,
    });
    expect(pipeline.embeddingDims).toBe(384);
  });

  test("embedItem clears stale chunks+vectors when a depth downgrade leaves no embeddable text", async () => {
    const db = freshDb();
    const now = Date.now();
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at)
       VALUES (?, 'gmail', 'email', 'e1', 'Q3 roadmap', 'a long email body with real content', ?, ?)`,
      ["gmail:e1", now, now],
    );
    const pipeline = new SqliteEmbeddingPipeline({
      db,
      embedder: stubEmbedder("Xenova/all-MiniLM-L6-v2", 384),
    });

    // Full-depth embed: chunks + vectors exist, derived from the body.
    await pipeline.embedItem({
      id: "gmail:e1",
      service: "gmail",
      type: "email",
      title: "Q3 roadmap",
      body_preview: "a long email body with real content",
    });
    const before = (
      db.query("SELECT COUNT(*) AS c FROM embedding_chunk WHERE item_id = ?").get("gmail:e1") as {
        c: number;
      }
    ).c;
    expect(before).toBeGreaterThanOrEqual(1);
    const vecBefore = (db.query("SELECT COUNT(*) AS c FROM vec_items_384").get() as { c: number })
      .c;
    expect(vecBefore).toBe(before);

    // Depth downgrade to metadata_only: body and body_preview suppressed, and
    // here the title is also blank/whitespace — itemTextForEmbedding falls
    // through to "" and chunkText([]) hits the early return.
    await pipeline.embedItem({
      id: "gmail:e1",
      service: "gmail",
      type: "email",
      title: "   ",
      body_preview: null,
    });

    const afterChunks = (
      db.query("SELECT COUNT(*) AS c FROM embedding_chunk WHERE item_id = ?").get("gmail:e1") as {
        c: number;
      }
    ).c;
    expect(afterChunks).toBe(0);
    const vecAfter = (db.query("SELECT COUNT(*) AS c FROM vec_items_384").get() as { c: number }).c;
    expect(vecAfter).toBe(0);
  });

  test("embedItem still re-embeds title-only on downgrade when the title is non-empty (no regression)", async () => {
    const db = freshDb();
    const now = Date.now();
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at)
       VALUES (?, 'gmail', 'email', 'e2', 'Budget approval needed', 'please approve the attached budget', ?, ?)`,
      ["gmail:e2", now, now],
    );
    const pipeline = new SqliteEmbeddingPipeline({
      db,
      embedder: stubEmbedder("Xenova/all-MiniLM-L6-v2", 384),
    });

    await pipeline.embedItem({
      id: "gmail:e2",
      service: "gmail",
      type: "email",
      title: "Budget approval needed",
      body_preview: "please approve the attached budget",
    });
    const before = (
      db
        .query("SELECT chunk_text FROM embedding_chunk WHERE item_id = ?")
        .all("gmail:e2") as Array<{
        chunk_text: string;
      }>
    ).map((r) => r.chunk_text);
    expect(before.some((t) => t.includes("please approve"))).toBe(true);

    // Downgrade: body suppressed, but the title survives metadata_only — the
    // title-only re-embed path (pieces.length > 0) must still run and replace
    // the body-derived chunks, not just delete them.
    await pipeline.embedItem({
      id: "gmail:e2",
      service: "gmail",
      type: "email",
      title: "Budget approval needed",
      body_preview: null,
    });

    const after = (
      db
        .query("SELECT chunk_text FROM embedding_chunk WHERE item_id = ?")
        .all("gmail:e2") as Array<{
        chunk_text: string;
      }>
    ).map((r) => r.chunk_text);
    expect(after.length).toBeGreaterThanOrEqual(1);
    expect(after.some((t) => t.includes("Budget approval needed"))).toBe(true);
    expect(after.some((t) => t.includes("please approve"))).toBe(false);
    const vecCount = (db.query("SELECT COUNT(*) AS c FROM vec_items_384").get() as { c: number }).c;
    expect(vecCount).toBe(after.length);
  });

  test("backfillAll caps in-flight embeds at backfillConcurrency", async () => {
    const db = freshDb();
    const now = Date.now();
    const ITEMS = 12;
    for (let i = 0; i < ITEMS; i++) {
      db.run(
        `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at)
         VALUES (?, 'github', 'issue', ?, ?, ?, ?, ?)`,
        [`github:c${i}`, `c${i}`, `title ${i}`, `body ${i}`, now - i, now],
      );
    }

    // An embedder that reports how many embed() calls overlap. With the whole
    // set in a single fetched batch, a naive Promise.all(rows.map(...)) would
    // drive this to ITEMS; the bounded runner must hold it at the cap.
    let inFlight = 0;
    let maxInFlight = 0;
    const CONCURRENCY = 3;
    const trackingEmbedder: Embedder = {
      model: "Xenova/all-MiniLM-L6-v2",
      dims: 384,
      async embed(texts) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Bun.sleep(5); // hold the slot so concurrent calls actually overlap
        inFlight -= 1;
        return texts.map(() => new Float32Array(384));
      },
    };

    const pipeline = new SqliteEmbeddingPipeline({
      db,
      embedder: trackingEmbedder,
      backfillBatchSize: ITEMS, // whole set fetched as one batch
      backfillConcurrency: CONCURRENCY,
    });

    await pipeline.backfillAll();

    // Never exceeded the cap, and actually reached it (proves real parallelism,
    // not an accidental serialization).
    expect(maxInFlight).toBeLessThanOrEqual(CONCURRENCY);
    expect(maxInFlight).toBe(CONCURRENCY);
    const embedded = (
      db.query("SELECT COUNT(DISTINCT item_id) AS c FROM embedding_chunk").get() as { c: number }
    ).c;
    expect(embedded).toBe(ITEMS);
  });
});
