import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { isVecLoaded, tryLoadSqliteVec } from "../index/sqlite-vec-load.ts";
import { SqliteEmbeddingPipeline } from "./pipeline.ts";
import { RoutingEmbeddingPipeline } from "./routing-pipeline.ts";
import type { Embedder } from "./types.ts";

function vecAvailable(): boolean {
  const db = new Database(":memory:");
  tryLoadSqliteVec(db);
  const ok = isVecLoaded(db);
  db.close();
  return ok;
}
const VEC_AVAILABLE = vecAvailable();

function stubEmbedder(model: string, dims: number): Embedder {
  return {
    model,
    dims,
    // Every callsite in this file names either the local MiniLM stand-in or the OpenAI one —
    // derive locality from that naming instead of threading a fourth param through every call.
    isLocal: !model.startsWith("openai:"),
    async embed(texts) {
      return texts.map(() => new Float32Array(dims));
    },
  };
}

function freshDb(): Database {
  const db = new Database(":memory:");
  tryLoadSqliteVec(db);
  runIndexedSchemaMigrations(db, 30);
  return db;
}

function insertItem(db: Database, id: string, service: string, type: string): void {
  const now = Date.now();
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body_preview,
        modified_at, synced_at)
     VALUES (?, ?, ?, ?, 'T', 'B', ?, ?)`,
    [`${service}:${id}`, service, type, id, now, now],
  );
}

describe("RoutingEmbeddingPipeline", () => {
  test.skipIf(!VEC_AVAILABLE)("prose-heavy items route to the OpenAI inner pipeline", async () => {
    const db = freshDb();
    insertItem(db, "e1", "slack", "message");
    const local = new SqliteEmbeddingPipeline({
      db,
      embedder: stubEmbedder("Xenova/all-MiniLM-L6-v2", 384),
    });
    const openai = new SqliteEmbeddingPipeline({
      db,
      embedder: stubEmbedder("openai:text-embedding-3-small", 1536),
    });
    const router = new RoutingEmbeddingPipeline(db, local, openai);
    await router.embedItem({
      id: "slack:e1",
      service: "slack",
      type: "message",
      title: "hello",
      body_preview: "world",
    });
    const dims = db
      .query(`SELECT dims FROM embedding_chunk WHERE item_id = ?`)
      .all("slack:e1") as Array<{ dims: number }>;
    expect(dims.length).toBeGreaterThan(0);
    expect(dims.every((r) => r.dims === 1536)).toBe(true);
  });

  test.skipIf(!VEC_AVAILABLE)("non-prose items route to the local inner pipeline", async () => {
    const db = freshDb();
    insertItem(db, "e2", "github", "git_commit");
    const local = new SqliteEmbeddingPipeline({
      db,
      embedder: stubEmbedder("Xenova/all-MiniLM-L6-v2", 384),
    });
    const openai = new SqliteEmbeddingPipeline({
      db,
      embedder: stubEmbedder("openai:text-embedding-3-small", 1536),
    });
    const router = new RoutingEmbeddingPipeline(db, local, openai);
    await router.embedItem({
      id: "github:e2",
      service: "github",
      type: "git_commit",
      title: "fix",
      body_preview: "diff",
    });
    const dims = db
      .query(`SELECT dims FROM embedding_chunk WHERE item_id = ?`)
      .all("github:e2") as Array<{ dims: number }>;
    expect(dims.length).toBeGreaterThan(0);
    expect(dims.every((r) => r.dims === 384)).toBe(true);
  });

  test.skipIf(!VEC_AVAILABLE)("backfillAll uses disjoint scopes", async () => {
    const db = freshDb();
    insertItem(db, "e1", "slack", "message");
    insertItem(db, "e2", "github", "git_commit");
    insertItem(db, "e3", "obsidian", "obsidian_note");

    const local = new SqliteEmbeddingPipeline({
      db,
      embedder: stubEmbedder("Xenova/all-MiniLM-L6-v2", 384),
    });
    const openai = new SqliteEmbeddingPipeline({
      db,
      embedder: stubEmbedder("openai:text-embedding-3-small", 1536),
    });
    const router = new RoutingEmbeddingPipeline(db, local, openai);
    await router.backfillAll();

    const rows = db
      .query(
        `SELECT item_id, dims FROM embedding_chunk
         GROUP BY item_id, dims ORDER BY item_id`,
      )
      .all() as Array<{ item_id: string; dims: number }>;
    const dimByItem = new Map(rows.map((r) => [r.item_id, r.dims]));
    expect(dimByItem.get("slack:e1")).toBe(1536);
    expect(dimByItem.get("github:e2")).toBe(384);
    expect(dimByItem.get("obsidian:e3")).toBe(1536);
  });

  test.skipIf(!VEC_AVAILABLE)(
    "deleteItemEmbeddings removes chunks AND fans out via dim-aware triggers",
    async () => {
      const db = freshDb();
      insertItem(db, "e1", "slack", "message");
      const local = new SqliteEmbeddingPipeline({
        db,
        embedder: stubEmbedder("Xenova/all-MiniLM-L6-v2", 384),
      });
      const openai = new SqliteEmbeddingPipeline({
        db,
        embedder: stubEmbedder("openai:text-embedding-3-small", 1536),
      });
      const router = new RoutingEmbeddingPipeline(db, local, openai);
      await router.embedItem({
        id: "slack:e1",
        service: "slack",
        type: "message",
        title: "hello",
        body_preview: "world",
      });
      const before = (db.query(`SELECT count(*) AS c FROM vec_items_1536`).get() as { c: number })
        .c;
      expect(before).toBeGreaterThan(0);

      await router.deleteItemEmbeddings("slack:e1");

      expect(
        (
          db
            .query(`SELECT count(*) AS c FROM embedding_chunk WHERE item_id = ?`)
            .get("slack:e1") as {
            c: number;
          }
        ).c,
      ).toBe(0);
      expect((db.query(`SELECT count(*) AS c FROM vec_items_1536`).get() as { c: number }).c).toBe(
        0,
      );
    },
  );
});
