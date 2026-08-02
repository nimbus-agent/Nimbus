import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";
import { isVecLoaded, tryLoadSqliteVec } from "../index/sqlite-vec-load.ts";
import { reindexConnector } from "./reindex.ts";

// sqlite-vec is an optional native extension (see sqlite-vec-load.ts). These
// tests assert real vec0 virtual-table behaviour, so they skip cleanly on a
// platform where the extension can't load rather than false-failing.
function vecAvailable(): boolean {
  const probe = new Database(":memory:");
  tryLoadSqliteVec(probe);
  const ok = isVecLoaded(probe);
  probe.close();
  return ok;
}
const VEC_AVAILABLE = vecAvailable();

function makeIdx(): LocalIndex {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return new LocalIndex(db);
}

function seedItem(idx: LocalIndex, opts: { id: string; service: string; body: string }): number {
  idx.rawDb.run(
    `INSERT INTO item (
       id, service, type, external_id, title, body, body_preview, body_complete, modified_at, synced_at, pinned
     ) VALUES (?, ?, 'test', ?, 't', ?, ?, 1, ?, ?, 0)`,
    [opts.id, opts.service, opts.id, opts.body, opts.body.slice(0, 100), Date.now(), Date.now()],
  );
  const row = idx.rawDb.query(`SELECT rowid AS rowid FROM item WHERE id = ?`).get(opts.id) as {
    rowid: number;
  };
  return row.rowid;
}

function seedChunk(
  idx: LocalIndex,
  opts: { itemId: string; chunkIndex: number; vecRowid: number; dims: 384 | 1536; text: string },
): void {
  const table = `vec_items_${opts.dims}`;
  const vec = new Float32Array(opts.dims);
  vec[0] = 1;
  idx.rawDb.run(`INSERT INTO ${table} (rowid, embedding) VALUES (?, vec_f32(?))`, [
    opts.vecRowid,
    vec,
  ]);
  idx.rawDb.run(
    `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
     VALUES (?, ?, ?, ?, 'test-model', ?, ?)`,
    [opts.itemId, opts.chunkIndex, opts.text, opts.vecRowid, opts.dims, Date.now()],
  );
}

describe.skipIf(!VEC_AVAILABLE)("metadata_only reindex — erasure completeness", () => {
  // BUG 1: reindex.ts has zero references to embedding_chunk. A metadata_only
  // reindex nulls item.body/body_preview but leaves the plaintext chunk_text
  // sitting in embedding_chunk untouched and readable.
  test("BUG 1: embedding_chunk rows must not survive a metadata_only reindex", async () => {
    const idx = makeIdx();
    seedItem(idx, { id: "slack:1", service: "slack", body: "secret".repeat(200) });
    seedChunk(idx, {
      itemId: "slack:1",
      chunkIndex: 0,
      vecRowid: 1,
      dims: 384,
      text: "secret chunk text that must be erased",
    });

    await reindexConnector({ index: idx, service: "slack", depth: "metadata_only" });

    const remaining = idx.rawDb
      .query(`SELECT COUNT(*) AS c FROM embedding_chunk WHERE item_id = ?`)
      .get("slack:1") as { c: number };
    expect(remaining.c).toBe(0);
  });

  // BUG 2: the vector delete in reindex.ts does
  //   DELETE FROM vec_items_384 WHERE rowid = ?
  // using the ITEM table's rowid. vec_rowid is a table-wide monotonic counter
  // assigned in embedding/pipeline.ts, unrelated to any item's rowid. This
  // fixture makes the two id spaces diverge on purpose: item1 is inserted
  // first with THREE chunks (consuming vec_rowid 1,2,3), so item2 — inserted
  // second, so item.rowid = 2 — gets vec_rowid 4, while item.rowid 2 actually
  // belongs to one of item1's OWN chunks. That is precisely the collision the
  // buggy code exploits: redacting item2 must not touch item1's vectors, and
  // must actually remove item2's own vector (vec_rowid 4).
  test("BUG 2: vector delete must key off the chunk's vec_rowid, not the item's rowid", async () => {
    const idx = makeIdx();

    seedItem(idx, { id: "other:item1", service: "other", body: "item1 body" });
    seedChunk(idx, { itemId: "other:item1", chunkIndex: 0, vecRowid: 1, dims: 384, text: "c0" });
    seedChunk(idx, { itemId: "other:item1", chunkIndex: 1, vecRowid: 2, dims: 384, text: "c1" });
    seedChunk(idx, { itemId: "other:item1", chunkIndex: 2, vecRowid: 3, dims: 384, text: "c2" });

    const item2Rowid = seedItem(idx, {
      id: "target:item2",
      service: "target",
      body: "item2 body",
    });
    seedChunk(idx, { itemId: "target:item2", chunkIndex: 0, vecRowid: 4, dims: 384, text: "c0" });

    // Confirm the fixture actually creates the id collision this test exists to
    // expose: item2's own rowid must equal one of item1's vec_rowids (not its own).
    expect(item2Rowid).toBe(2);

    await reindexConnector({ index: idx, service: "target", depth: "metadata_only" });

    // (i) every vector belonging to the redacted item (vec_rowid 4) must be gone.
    const redactedVec = idx.rawDb
      .query(`SELECT COUNT(*) AS c FROM vec_items_384 WHERE rowid = 4`)
      .get() as { c: number };
    expect(redactedVec.c).toBe(0);

    // (ii) vectors belonging to the OTHER, unredacted item must be untouched.
    const otherVecCount = idx.rawDb
      .query(`SELECT COUNT(*) AS c FROM vec_items_384 WHERE rowid IN (1, 2, 3)`)
      .get() as { c: number };
    expect(otherVecCount.c).toBe(3);
  });
});
