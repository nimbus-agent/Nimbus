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
    expect(hits).toHaveLength(1);
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
    expect(hits).toHaveLength(1);
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
    expect(hits).toHaveLength(0);
  });

  test.skipIf(!VEC_AVAILABLE)("with only the 1536 vector, returns only vec_items_1536 hits", () => {
    const db = freshDb();
    seed(db);
    const v1536 = new Float32Array(1536);
    v1536[0] = 1;
    const hits = vectorSearchChunksDual(db, {
      queryEmbedding1536: v1536,
      model1536: "m1536",
      limit: 10,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.itemId).toBe("s:b");
  });

  test.skipIf(!VEC_AVAILABLE)("service filter narrows results to matching service", () => {
    const db = freshDb();
    seed(db);
    const v384 = new Float32Array(384);
    v384[0] = 1;
    const v1536 = new Float32Array(1536);
    v1536[0] = 1;
    // Only github items should be returned when service='github'
    const hits = vectorSearchChunksDual(db, {
      queryEmbedding384: v384,
      queryEmbedding1536: v1536,
      model384: "m384",
      model1536: "m1536",
      limit: 10,
      service: "github",
    });
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h.itemId).toBe("s:a");
    }
  });

  test.skipIf(!VEC_AVAILABLE)("itemType filter narrows results to matching type", () => {
    const db = freshDb();
    seed(db);
    const v384 = new Float32Array(384);
    v384[0] = 1;
    const v1536 = new Float32Array(1536);
    v1536[0] = 1;
    // Only message items should be returned when itemType='message'
    const hits = vectorSearchChunksDual(db, {
      queryEmbedding384: v384,
      queryEmbedding1536: v1536,
      model384: "m384",
      model1536: "m1536",
      limit: 10,
      itemType: "message",
    });
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h.itemId).toBe("s:b");
    }
  });

  test.skipIf(!VEC_AVAILABLE)("since filter excludes items older than threshold", () => {
    const db = freshDb();
    seed(db);
    const v384 = new Float32Array(384);
    v384[0] = 1;
    // Use a far-future since to exclude everything
    const farFuture = Date.now() + 1_000_000_000;
    const hits = vectorSearchChunksDual(db, {
      queryEmbedding384: v384,
      model384: "m384",
      limit: 10,
      since: farFuture,
    });
    expect(hits).toHaveLength(0);
  });

  test.skipIf(!VEC_AVAILABLE)("since filter includes items at or after threshold", () => {
    const db = freshDb();
    seed(db);
    const v384 = new Float32Array(384);
    v384[0] = 1;
    // Use 0 as since — all items (modified_at >= 0) should be included
    const hits = vectorSearchChunksDual(db, {
      queryEmbedding384: v384,
      model384: "m384",
      limit: 10,
      since: 0,
    });
    // since=0 is treated as falsy (the vec-store applies the filter only when since > 0),
    // so it behaves as "no filter" and the 384-indexed item survives.
    expect(hits).toHaveLength(1);
    expect(hits[0]?.itemId).toBe("s:a");
  });

  test.skipIf(!VEC_AVAILABLE)(
    "since filter with positive value returns items modified after threshold",
    () => {
      const db = freshDb();
      seed(db);
      const v384 = new Float32Array(384);
      v384[0] = 1;
      // Use a past time well before the seeded items so everything passes through
      const pastTime = Date.now() - 10_000;
      const hits = vectorSearchChunksDual(db, {
        queryEmbedding384: v384,
        model384: "m384",
        limit: 10,
        since: pastTime,
      });
      expect(hits).toHaveLength(1);
      expect(hits[0]?.itemId).toBe("s:a");
    },
  );
});
