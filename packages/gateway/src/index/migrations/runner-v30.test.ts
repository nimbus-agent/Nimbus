import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { isVecLoaded, tryLoadSqliteVec } from "../sqlite-vec-load.ts";
import { runIndexedSchemaMigrations } from "./runner.ts";

function vecAvailable(): boolean {
  const db = new Database(":memory:");
  tryLoadSqliteVec(db);
  const ok = isVecLoaded(db);
  db.close();
  return ok;
}
// sqlite-vec genuinely does not load on macOS CI (#1029). An in-body early
// return on load failure registers as a PASS, not a skip, so a green run there
// was indistinguishable from a fully-exercised one — skipIf makes it honest.
const VEC_AVAILABLE = vecAvailable();

describe("V30 migration — vec_items_1536 + dim-aware triggers", () => {
  test("running migrations on a fresh DB advances user_version to 30", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 30);
    const row = db.query("PRAGMA user_version").get() as { user_version: number };
    expect(row.user_version).toBe(30);
  });

  test("V30 no-vec fallback does not throw on bun:sqlite (regression: macOS rejected db.exec(''))", () => {
    const db = new Database(":memory:");
    expect(() => runIndexedSchemaMigrations(db, 30)).not.toThrow();
  });

  test("V30 records an applied row in _schema_migrations", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 30);
    const row = db
      .query("SELECT version, description, applied_at FROM _schema_migrations WHERE version = 30")
      .get() as { version: number; description: string; applied_at: number } | null;
    expect(row?.version).toBe(30);
    expect(row?.description).toContain("vec_items_1536");
    expect(row?.applied_at).toBeGreaterThan(0);
  });

  test.skipIf(!VEC_AVAILABLE)(
    "with sqlite-vec, vec_items_1536 exists and dim-aware triggers are wired",
    () => {
      const db = new Database(":memory:");
      tryLoadSqliteVec(db);
      runIndexedSchemaMigrations(db, 30);
      const tables = db
        .query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vec_items_1536'`)
        .all() as Array<{ name: string }>;
      expect(tables).toHaveLength(1);
      const triggers = db
        .query(
          `SELECT name, sql FROM sqlite_master WHERE type = 'trigger'
         AND name IN ('embedding_chunk_ad_delete_vec384', 'embedding_chunk_ad_delete_vec1536')`,
        )
        .all() as Array<{ name: string; sql: string }>;
      expect(triggers).toHaveLength(2);
      const t384 = triggers.find((t) => t.name === "embedding_chunk_ad_delete_vec384");
      const t1536 = triggers.find((t) => t.name === "embedding_chunk_ad_delete_vec1536");
      expect(t384?.sql).toContain("WHEN OLD.dims = 384");
      expect(t1536?.sql).toContain("WHEN OLD.dims = 1536");
    },
  );

  test.skipIf(!VEC_AVAILABLE)(
    "delete via embedding_chunk fans out to the matching vec table only",
    () => {
      const db = new Database(":memory:");
      tryLoadSqliteVec(db);
      runIndexedSchemaMigrations(db, 30);
      db.run(
        `INSERT INTO item (id, service, type, external_id, title, body_preview,
          modified_at, synced_at) VALUES (?, 's', 't', 'e', 'T', NULL, ?, ?)`,
        ["s:e", Date.now(), Date.now()],
      );
      db.run(`INSERT INTO vec_items_384  (rowid, embedding) VALUES (1, vec_f32(?))`, [
        new Float32Array(384),
      ]);
      db.run(`INSERT INTO vec_items_1536 (rowid, embedding) VALUES (1, vec_f32(?))`, [
        new Float32Array(1536),
      ]);
      db.run(
        `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
       VALUES (?, 0, 't', 1, 'm384', 384, ?)`,
        ["s:e", Date.now()],
      );
      db.run(
        `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
       VALUES (?, 1, 't', 1, 'm1536', 1536, ?)`,
        ["s:e", Date.now()],
      );

      db.run(`DELETE FROM embedding_chunk WHERE chunk_index = 0`);
      expect((db.query(`SELECT count(*) AS c FROM vec_items_384 `).get() as { c: number }).c).toBe(
        0,
      );
      expect((db.query(`SELECT count(*) AS c FROM vec_items_1536`).get() as { c: number }).c).toBe(
        1,
      );

      db.run(`DELETE FROM embedding_chunk WHERE chunk_index = 1`);
      expect((db.query(`SELECT count(*) AS c FROM vec_items_1536`).get() as { c: number }).c).toBe(
        0,
      );
    },
  );
});
