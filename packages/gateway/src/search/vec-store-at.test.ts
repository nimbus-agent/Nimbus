import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { buildAtClause } from "../index/item-history-at.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { isVecLoaded, tryLoadSqliteVec } from "../index/sqlite-vec-load.ts";
import { buildVectorChunkQuery, vectorSearchChunks } from "./vec-store.ts";

function vecAvailable(): boolean {
  const db = new Database(":memory:");
  tryLoadSqliteVec(db);
  const ok = isVecLoaded(db);
  db.close();
  return ok;
}
const VEC_AVAILABLE = vecAvailable();

const QUERY = (() => {
  const v = new Float32Array(384);
  v[0] = 1;
  return v;
})();

describe("buildVectorChunkQuery with at", () => {
  test("the clause is a trailing AND and its params come last, in order", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
    const at = buildAtClause(db, 1000, "i");
    const plain = buildVectorChunkQuery({
      queryEmbedding: QUERY,
      model: "m",
      limit: 5,
      service: "github",
    });
    const withAt = buildVectorChunkQuery({
      queryEmbedding: QUERY,
      model: "m",
      limit: 5,
      service: "github",
      at,
    });
    expect(withAt.sql.startsWith(plain.sql.split("ORDER BY")[0] as string)).toBe(true);
    expect(withAt.sql).toContain(` AND ${at.sql}`);
    expect(withAt.params.slice(0, plain.params.length)).toEqual(plain.params);
    expect(withAt.params.slice(plain.params.length)).toEqual([...at.params]);
    // The KNN stays the outer loop: still CROSS JOIN, with the temporal clause after the join.
    expect(withAt.sql).toContain("CROSS JOIN embedding_chunk");
    expect(withAt.sql.indexOf(at.sql)).toBeGreaterThan(withAt.sql.indexOf("CROSS JOIN item i"));
    db.close();
  });

  test("without at the query is unchanged", () => {
    const a = buildVectorChunkQuery({ queryEmbedding: QUERY, model: "m", limit: 5 });
    expect(a.sql).not.toContain("item_history");
  });
});

describe("vectorSearchChunks with at", () => {
  test.skipIf(!VEC_AVAILABLE)(
    "a post-T item whose chunk is the NEAREST is not returned; the next-nearest admitted one is",
    () => {
      const db = new Database(":memory:");
      tryLoadSqliteVec(db);
      runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
      const put = (ext: string, opened: number, at: number): void =>
        upsertIndexedItem(db, {
          service: "github",
          type: "pr",
          externalId: ext,
          title: ext,
          modifiedAt: at,
          syncedAt: at,
          metadata: { state: "open", opened_at_ms: opened },
        });
      put("seed", 90, 100);
      put("early", 150, 200);
      put("late", 1200, 1300);
      const chunk = (rowid: number, id: string, nearness: number): void => {
        const v = new Float32Array(384);
        v[0] = 1;
        v[1] = nearness;
        db.run("INSERT INTO vec_items_384 (rowid, embedding) VALUES (?, vec_f32(?))", [rowid, v]);
        db.run(
          `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
           VALUES (?, 0, 'c', ?, 'local:minilm', 384, 1)`,
          [id, rowid],
        );
      };
      chunk(1, "github:late", 0.001);
      chunk(2, "github:early", 0.01);
      chunk(3, "github:seed", 0.5);
      const base = { queryEmbedding: QUERY, model: "local:minilm", limit: 500 };
      expect(vectorSearchChunks(db, base).map((h) => h.itemId)).toEqual([
        "github:late",
        "github:early",
        "github:seed",
      ]);
      const then = vectorSearchChunks(db, { ...base, at: buildAtClause(db, 1000, "i") });
      expect(then.map((h) => h.itemId)).toEqual(["github:early", "github:seed"]);
      db.close();
    },
  );
});
