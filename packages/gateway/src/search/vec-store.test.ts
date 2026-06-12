import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { isVecLoaded, tryLoadSqliteVec } from "../index/sqlite-vec-load.ts";
import { vectorSearchChunks } from "./vec-store.ts";

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

describe("vectorSearchChunks — dim awareness", () => {
  test.skipIf(!VEC_AVAILABLE)("rejects unsupported query embedding dimensions", () => {
    const db = freshDb();
    expect(() =>
      vectorSearchChunks(db, {
        queryEmbedding: new Float32Array(512),
        model: "any",
        limit: 5,
      }),
    ).toThrow(/unsupported query embedding dim/);
  });

  test.skipIf(!VEC_AVAILABLE)("queries vec_items_1536 when given a 1536-dim embedding", () => {
    const db = freshDb();
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview,
          modified_at, synced_at)
       VALUES ('s:1', 's', 't', '1', 'T', 'B', ?, ?)`,
      [Date.now(), Date.now()],
    );
    const v = new Float32Array(1536);
    v[0] = 1;
    db.run(`INSERT INTO vec_items_1536 (rowid, embedding) VALUES (1, vec_f32(?))`, [v]);
    db.run(
      `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
       VALUES ('s:1', 0, 'hi', 1, 'openai:text-embedding-3-small', 1536, ?)`,
      [Date.now()],
    );
    const hits = vectorSearchChunks(db, {
      queryEmbedding: v,
      model: "openai:text-embedding-3-small",
      limit: 5,
    });
    expect(hits.length).toBe(1);
    expect(hits[0]?.itemId).toBe("s:1");
  });

  test.skipIf(!VEC_AVAILABLE)(
    "metadataChannelIn excludes hits from non-allowlisted channels",
    () => {
      const db = freshDb();
      // two slack messages, different channels stored in metadata.channel
      for (const [id, channel, rowid] of [
        ["slack:C1:1", "C1", 1],
        ["slack:C2:2", "C2", 2],
      ] as const) {
        db.run(
          `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at, metadata)
         VALUES (?, 'slack', 'message', ?, 'T', 'B', ?, ?, ?)`,
          [id, String(rowid), Date.now(), Date.now(), JSON.stringify({ channel })],
        );
        const v = new Float32Array(384);
        v[0] = 1;
        db.run(`INSERT INTO vec_items_384 (rowid, embedding) VALUES (?, vec_f32(?))`, [rowid, v]);
        db.run(
          `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
         VALUES (?, 0, 'hi', ?, 'minilm:all-MiniLM-L6-v2', 384, ?)`,
          [id, rowid, Date.now()],
        );
      }
      const q = new Float32Array(384);
      q[0] = 1;
      const hits = vectorSearchChunks(db, {
        queryEmbedding: q,
        model: "minilm:all-MiniLM-L6-v2",
        limit: 10,
        metadataChannelIn: ["C1"],
      });
      expect(hits.map((h) => h.itemId)).toEqual(["slack:C1:1"]);
    },
  );
});
