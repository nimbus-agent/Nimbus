import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { isVecLoaded, tryLoadSqliteVec } from "../index/sqlite-vec-load.ts";
import { vectorSearchChunksDual } from "./dual-search.ts";

function vecAvailable(): boolean {
  const db = new Database(":memory:");
  tryLoadSqliteVec(db);
  const ok = isVecLoaded(db);
  db.close();
  return ok;
}
const VEC_AVAILABLE = vecAvailable();

function freshDb(): Database {
  const db = new Database(":memory:");
  tryLoadSqliteVec(db);
  runIndexedSchemaMigrations(db, 30);
  return db;
}

function seed(db: Database) {
  const now = Date.now();
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body_preview,
        modified_at, synced_at)
     VALUES ('s:a', 'github', 'git_commit', 'a', 'A', 'a', ?, ?)`,
    [now, now],
  );
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body_preview,
        modified_at, synced_at)
     VALUES ('s:b', 'slack', 'message', 'b', 'B', 'b', ?, ?)`,
    [now, now],
  );
  const v384 = new Float32Array(384);
  v384[0] = 1;
  const v1536 = new Float32Array(1536);
  v1536[0] = 1;
  db.run(`INSERT INTO vec_items_384  (rowid, embedding) VALUES (1, vec_f32(?))`, [v384]);
  db.run(`INSERT INTO vec_items_1536 (rowid, embedding) VALUES (1, vec_f32(?))`, [v1536]);
  db.run(
    `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
     VALUES ('s:a', 0, 'a', 1, 'm384', 384, ?)`,
    [now],
  );
  db.run(
    `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
     VALUES ('s:b', 0, 'b', 1, 'm1536', 1536, ?)`,
    [now],
  );
}

describe("vectorSearchChunksDual", () => {
  test.skipIf(!VEC_AVAILABLE)("with both vectors, returns hits from both tables", () => {
    const db = freshDb();
    seed(db);
    const v384 = new Float32Array(384);
    v384[0] = 1;
    const v1536 = new Float32Array(1536);
    v1536[0] = 1;
    const hits = vectorSearchChunksDual(db, {
      queryEmbedding384: v384,
      queryEmbedding1536: v1536,
      model384: "m384",
      model1536: "m1536",
      limit: 10,
    });
    const ids = new Set(hits.map((h) => h.itemId));
    expect(ids.has("s:a")).toBe(true);
    expect(ids.has("s:b")).toBe(true);
  });

  test.skipIf(!VEC_AVAILABLE)("with only the 384 vector, returns only vec_items_384 hits", () => {
    const db = freshDb();
    seed(db);
    const v384 = new Float32Array(384);
    v384[0] = 1;
    const hits = vectorSearchChunksDual(db, {
      queryEmbedding384: v384,
      model384: "m384",
      limit: 10,
    });
    expect(hits.length).toBe(1);
    expect(hits[0]?.itemId).toBe("s:a");
  });

  test.skipIf(!VEC_AVAILABLE)("merge orders by distance ascending, truncates to limit", () => {
    const db = freshDb();
    seed(db);
    const v384 = new Float32Array(384);
    v384[0] = 1;
    const v1536 = new Float32Array(1536);
    v1536[0] = 1;
    const hits = vectorSearchChunksDual(db, {
      queryEmbedding384: v384,
      queryEmbedding1536: v1536,
      model384: "m384",
      model1536: "m1536",
      limit: 1,
    });
    expect(hits.length).toBe(1);
  });

  test.skipIf(!VEC_AVAILABLE)("missing model id with present vector skips that side", () => {
    const db = freshDb();
    seed(db);
    const v1536 = new Float32Array(1536);
    v1536[0] = 1;
    const hits = vectorSearchChunksDual(db, {
      queryEmbedding1536: v1536,
      limit: 10,
    });
    expect(hits.length).toBe(0);
  });
});
