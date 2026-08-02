import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { EMBEDDING_V6_NO_VEC_MIGRATION_SQL } from "../index/embedding-v6-sql.ts";
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

// CodeRabbit finding on #1026: `describe.skipIf(!VEC_AVAILABLE)` below is
// correct for local dev on a platform without the native extension, but if it
// silently skips in CI, every erasure-completeness test in this file
// disappears and a green CI run proves nothing about erasure — a "guard that
// cannot fail" of exactly the kind flagged before in this codebase (see
// scripts/coverage-floor/check.ts's `lcovHasBranchData` instrumentation
// canary for the same pattern: fail loudly on infrastructure absence rather
// than let a downstream check read a false, unearned pass). This is an
// always-running (never skipIf'd) canary: it is a no-op outside CI, and in CI
// specifically it turns "sqlite-vec didn't load" into a hard failure instead
// of a quiet skip, so the absence can never hide behind a green build.
test("CI must have sqlite-vec available, or the erasure-completeness suites below are silently absent", () => {
  const inCI = process.env["CI"] === "true";
  if (!inCI) {
    return;
  }
  expect(VEC_AVAILABLE).toBe(true);
});

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

// A pre-existing item that already ran (the old, broken) metadata_only and so
// already has body/body_preview NULL — but still carries orphaned
// embedding_chunk plaintext this fix must be able to clean up on a re-run.
function seedItemNoBody(idx: LocalIndex, opts: { id: string; service: string }): void {
  idx.rawDb.run(
    `INSERT INTO item (
       id, service, type, external_id, title, body, body_preview, body_complete, modified_at, synced_at, pinned
     ) VALUES (?, ?, 'test', ?, 't', NULL, NULL, 0, ?, ?, 0)`,
    [opts.id, opts.service, opts.id, Date.now(), Date.now()],
  );
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

  // CodeRabbit finding on #1026: the item probe only matched items with
  // non-empty body/body_preview. An item that already ran the OLD, broken
  // metadata_only has body/body_preview already NULL, so it no longer
  // matches — its orphaned embedding_chunk plaintext (and vector) is
  // invisible to every later run, including this fix's own. That is exactly
  // the population that already asked for erasure and didn't get it, and a
  // re-run must be able to repair them.
  test("orphaned embedding_chunk rows are erased even when body/body_preview are already NULL", async () => {
    const idx = makeIdx();
    seedItemNoBody(idx, { id: "orphan:1", service: "orphan" });
    seedChunk(idx, {
      itemId: "orphan:1",
      chunkIndex: 0,
      vecRowid: 1,
      dims: 384,
      text: "orphaned plaintext from a pre-fix metadata_only run",
    });

    const result = await reindexConnector({
      index: idx,
      service: "orphan",
      depth: "metadata_only",
    });
    expect(result.itemsAffected).toBe(1);

    const remaining = idx.rawDb
      .query(`SELECT COUNT(*) AS c FROM embedding_chunk WHERE item_id = ?`)
      .get("orphan:1") as { c: number };
    expect(remaining.c).toBe(0);

    const vecRemaining = idx.rawDb
      .query(`SELECT COUNT(*) AS c FROM vec_items_384 WHERE rowid = 1`)
      .get() as { c: number };
    expect(vecRemaining.c).toBe(0);
  });
});

// Reproduces the genuine "sqlite-vec extension unavailable" end-state used by
// the `*_NO_VEC_*` migration variants (index/embedding-v6-sql.ts,
// index/vec-items-1536-v30-sql.ts): no vec tables, no `AFTER DELETE ON
// embedding_chunk` cascade triggers, and `embedding_chunk.vec_rowid` nullable.
// `runIndexedSchemaMigrations` picks that branch only when the native
// extension genuinely fails to load (V6) or the vec table is genuinely absent
// (V10/V30) — neither of which this machine reproduces, since sqlite-vec IS
// available here. Rather than fake a failed native-extension load, this
// starts from the real (vec-loaded) schema and reshapes exactly the
// embedding-related objects to the documented NO_VEC shape, reusing the
// production `EMBEDDING_V6_NO_VEC_MIGRATION_SQL` constant verbatim so the
// resulting schema is byte-for-byte what a genuine no-vec install has.
function makeNoVecIdx(): LocalIndex {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  db.exec(`DROP TRIGGER IF EXISTS embedding_chunk_ad_delete_vec384`);
  db.exec(`DROP TRIGGER IF EXISTS embedding_chunk_ad_delete_vec1536`);
  db.exec(`DROP TABLE IF EXISTS vec_items_384`);
  db.exec(`DROP TABLE IF EXISTS vec_items_1536`);
  db.exec(`DROP TABLE IF EXISTS embedding_chunk`);
  db.exec(EMBEDDING_V6_NO_VEC_MIGRATION_SQL);
  return new LocalIndex(db);
}

describe.skipIf(!VEC_AVAILABLE)("metadata_only reindex — defensive branch coverage", () => {
  // Coverage gap 1: on a no-vec install there is no vec_items_384/1536 table to
  // delete from at all. The per-chunk loop's explicit delete must throw
  // "no such table", isMissingVecTableError must recognize it and swallow it,
  // and the erasure of embedding_chunk (the actual data-minimization) must
  // still complete without the promise rejecting.
  test("tolerates a missing vec table: erasure completes, nothing throws", async () => {
    const idx = makeNoVecIdx();
    seedItem(idx, { id: "novec:1", service: "novec", body: "secret".repeat(50) });
    idx.rawDb.run(
      `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
       VALUES (?, 0, ?, ?, 'test-model', 384, ?)`,
      ["novec:1", "chunk text", 1, Date.now()],
    );

    await expect(
      reindexConnector({ index: idx, service: "novec", depth: "metadata_only" }),
    ).resolves.toEqual({ itemsAffected: 1, depth: "metadata_only", mode: "shallow" });

    const remaining = idx.rawDb
      .query(`SELECT COUNT(*) AS c FROM embedding_chunk WHERE item_id = ?`)
      .get("novec:1") as { c: number };
    expect(remaining.c).toBe(0);
  });

  // Coverage gap 3: the no-vec schema variant allows embedding_chunk.vec_rowid
  // to be NULL (there's no vec table to point at). The per-chunk loop must
  // skip such a row (never attempt a delete keyed on a null rowid) while still
  // erasing its embedding_chunk row via the unconditional delete above it.
  test("tolerates a NULL vec_rowid: skips the vec delete, still erases the chunk row", async () => {
    const idx = makeNoVecIdx();
    seedItem(idx, { id: "novec:2", service: "novec", body: "secret".repeat(50) });
    idx.rawDb.run(
      `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
       VALUES (?, 0, ?, NULL, 'test-model', 384, ?)`,
      ["novec:2", "chunk text", Date.now()],
    );

    await expect(
      reindexConnector({ index: idx, service: "novec", depth: "metadata_only" }),
    ).resolves.toEqual({ itemsAffected: 1, depth: "metadata_only", mode: "shallow" });

    const remaining = idx.rawDb
      .query(`SELECT COUNT(*) AS c FROM embedding_chunk WHERE item_id = ?`)
      .get("novec:2") as { c: number };
    expect(remaining.c).toBe(0);
  });

  // Coverage gap 4: `embedding/pipeline.ts` never writes a chunk with a `dims`
  // outside SUPPORTED_EMBEDDING_DIMS (it throws first, at embed time) — so
  // this specific row shape cannot occur via the normal write path. It can
  // still occur via direct SQL (a stray/corrupt row, or a future embedding
  // provider with a different dimension count landing before this file is
  // updated). The guard exists for exactly that defensive reason, so this
  // seeds the row directly to exercise it: the loop must skip a chunk whose
  // `dims` isn't a table this codebase knows how to route to, rather than
  // guess a table name and blow up.
  test("tolerates an unsupported dims value: skips the vec delete, still erases the chunk row", async () => {
    const idx = makeIdx();
    seedItem(idx, { id: "weird:1", service: "weird", body: "secret".repeat(50) });
    idx.rawDb.run(
      `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
       VALUES (?, 0, ?, 1, 'test-model', 999, ?)`,
      ["weird:1", "chunk text", Date.now()],
    );

    await expect(
      reindexConnector({ index: idx, service: "weird", depth: "metadata_only" }),
    ).resolves.toEqual({ itemsAffected: 1, depth: "metadata_only", mode: "shallow" });

    const remaining = idx.rawDb
      .query(`SELECT COUNT(*) AS c FROM embedding_chunk WHERE item_id = ?`)
      .get("weird:1") as { c: number };
    expect(remaining.c).toBe(0);
  });

  // Coverage gap 2 (the important arm): a REAL, non-"missing table" failure
  // from the vec delete must propagate, not be swallowed as if erasure
  // succeeded. The AFTER DELETE cascade trigger is dropped first so that the
  // `DELETE FROM embedding_chunk` statement itself (unwrapped, line above the
  // loop) succeeds cleanly — isolating the assertion to OUR OWN per-chunk
  // delete's error handling rather than the trigger's. vec_items_384 is then
  // reshaped into a WITHOUT ROWID table (the same technique
  // db/repair.test.ts uses for its "vec_items_384 is WITHOUT ROWID" fixture),
  // so `DELETE FROM vec_items_384 WHERE rowid = ?` throws a genuine SQLite
  // error — "no such column: rowid" — that does not match "no such table" and
  // must not be swallowed.
  test("a genuine non-missing-table vec delete failure propagates and rolls back", async () => {
    const idx = makeIdx();
    idx.rawDb.run(`DROP TRIGGER IF EXISTS embedding_chunk_ad_delete_vec384`);
    idx.rawDb.run(`DROP TABLE vec_items_384`);
    idx.rawDb.exec(`
      CREATE TABLE vec_items_384 (
        vec_id INTEGER NOT NULL,
        PRIMARY KEY (vec_id)
      ) WITHOUT ROWID
    `);

    seedItem(idx, { id: "broken:1", service: "broken", body: "secret".repeat(50) });
    idx.rawDb.run(
      `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
       VALUES (?, 0, ?, 1, 'test-model', 384, ?)`,
      ["broken:1", "chunk text", Date.now()],
    );

    await expect(
      reindexConnector({ index: idx, service: "broken", depth: "metadata_only" }),
    ).rejects.toThrow(/no such column/i);

    // Fail-closed: the throw must roll back the WHOLE transaction, not just
    // stop short. The item's body must survive untouched — a real failure
    // must never leave a partial, "looks erased but isn't fully" state.
    const row = idx.rawDb.query(`SELECT body FROM item WHERE id = ?`).get("broken:1") as {
      body: string | null;
    };
    expect(row.body).not.toBeNull();
  });
});
