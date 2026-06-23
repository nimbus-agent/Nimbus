import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { isVecLoaded, tryLoadSqliteVec } from "../index/sqlite-vec-load.ts";
import { hybridSearch } from "./hybrid.ts";

function vecAvailable(): boolean {
  const db = new Database(":memory:");
  tryLoadSqliteVec(db);
  const ok = isVecLoaded(db);
  db.close();
  return ok;
}
const VEC_AVAILABLE = vecAvailable();

describe("hybridSearch", () => {
  test("BM25-only path when query embedding is absent", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const now = Date.now();
    upsertIndexedItem(db, {
      service: "s",
      type: "file",
      externalId: "a",
      title: "alpha bravo",
      modifiedAt: now,
      syncedAt: now,
    });
    const rows = await hybridSearch(db, {
      query: "alpha",
      limit: 10,
      embeddingModel: "m1",
      semantic: true,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.item.id).toBe("s:a");
  });

  test.skipIf(!VEC_AVAILABLE)("vector + BM25 RRF returns both item kinds", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const now = Date.now();
    upsertIndexedItem(db, {
      service: "s",
      type: "file",
      externalId: "fts",
      title: "keyword match here",
      bodyPreview: "nothing",
      modifiedAt: now,
      syncedAt: now,
    });
    upsertIndexedItem(db, {
      service: "s",
      type: "file",
      externalId: "vec",
      title: "unrelated title",
      bodyPreview: "other",
      modifiedAt: now,
      syncedAt: now,
    });
    const model = "vec-test";
    const vFts = new Float32Array(384);
    vFts[0] = 1;
    const vVec = new Float32Array(384);
    vVec[0] = 0.99;
    vVec[1] = 0.01;
    db.run(`INSERT INTO vec_items_384(rowid, embedding) VALUES (?, vec_f32(?))`, [1n, vFts]);
    db.run(
      `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
       VALUES (?, 0, 'chunk fts', 1, ?, 384, ?)`,
      ["s:fts", model, now],
    );
    db.run(`INSERT INTO vec_items_384(rowid, embedding) VALUES (?, vec_f32(?))`, [2n, vVec]);
    db.run(
      `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
       VALUES (?, 0, 'chunk vec', 2, ?, 384, ?)`,
      ["s:vec", model, now],
    );

    const q = new Float32Array(384);
    q[0] = 1;
    q[1] = 0;

    const rows = await hybridSearch(db, {
      query: "keyword",
      limit: 10,
      embeddingModel: model,
      semantic: true,
      queryEmbedding: q,
    });
    const ids = rows.map((r) => r.item.id).sort((a, b) => a.localeCompare(b));
    expect(ids).toEqual(["s:fts", "s:vec"]);
  });
});
