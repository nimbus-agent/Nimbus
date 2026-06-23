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

/** Insert a single item + embedding_chunk + vec row (1536-dim). */
function insertItem(
  db: Database,
  opts: {
    id: string;
    service: string;
    type: string;
    modifiedAt: number;
    chunkText: string;
    rowid: number;
    model: string;
  },
): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [opts.id, opts.service, opts.type, opts.id, "T", "B", opts.modifiedAt, opts.modifiedAt],
  );
  const v = new Float32Array(1536);
  v[0] = 1;
  db.run(`INSERT INTO vec_items_1536 (rowid, embedding) VALUES (?, vec_f32(?))`, [opts.rowid, v]);
  db.run(
    `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
     VALUES (?, 0, ?, ?, ?, 1536, ?)`,
    [opts.id, opts.chunkText, opts.rowid, opts.model, opts.modifiedAt],
  );
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
    expect(hits).toHaveLength(1);
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

describe("vectorSearchChunks — optional filters", () => {
  test.skipIf(!VEC_AVAILABLE)("returns empty array when table has no rows", () => {
    const db = freshDb();
    const v = new Float32Array(1536);
    v[0] = 1;
    const hits = vectorSearchChunks(db, {
      queryEmbedding: v,
      model: "openai:text-embedding-3-small",
      limit: 5,
    });
    expect(hits).toHaveLength(0);
  });

  test.skipIf(!VEC_AVAILABLE)("service filter — empty string is treated as no filter", () => {
    const db = freshDb();
    const now = Date.now();
    insertItem(db, {
      id: "svc:1",
      service: "github",
      type: "issue",
      modifiedAt: now,
      chunkText: "github issue text",
      rowid: 1,
      model: "openai:text-embedding-3-small",
    });
    const v = new Float32Array(1536);
    v[0] = 1;
    const hits = vectorSearchChunks(db, {
      queryEmbedding: v,
      model: "openai:text-embedding-3-small",
      limit: 10,
      service: "",
    });
    // empty string → no service filter applied → item is returned
    expect(hits).toHaveLength(1);
    expect(hits[0]?.itemId).toBe("svc:1");
  });

  test.skipIf(!VEC_AVAILABLE)("service filter — matching service returns item", () => {
    const db = freshDb();
    const now = Date.now();
    insertItem(db, {
      id: "gh:1",
      service: "github",
      type: "issue",
      modifiedAt: now,
      chunkText: "gh issue",
      rowid: 1,
      model: "openai:text-embedding-3-small",
    });
    insertItem(db, {
      id: "sl:2",
      service: "slack",
      type: "message",
      modifiedAt: now,
      chunkText: "slack msg",
      rowid: 2,
      model: "openai:text-embedding-3-small",
    });
    const v = new Float32Array(1536);
    v[0] = 1;
    const hits = vectorSearchChunks(db, {
      queryEmbedding: v,
      model: "openai:text-embedding-3-small",
      limit: 10,
      service: "github",
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.itemId).toBe("gh:1");
  });

  test.skipIf(!VEC_AVAILABLE)("service filter — non-matching service returns empty", () => {
    const db = freshDb();
    const now = Date.now();
    insertItem(db, {
      id: "gh:1",
      service: "github",
      type: "issue",
      modifiedAt: now,
      chunkText: "gh issue",
      rowid: 1,
      model: "openai:text-embedding-3-small",
    });
    const v = new Float32Array(1536);
    v[0] = 1;
    const hits = vectorSearchChunks(db, {
      queryEmbedding: v,
      model: "openai:text-embedding-3-small",
      limit: 10,
      service: "notion",
    });
    expect(hits).toHaveLength(0);
  });

  test.skipIf(!VEC_AVAILABLE)("itemType filter — empty string is treated as no filter", () => {
    const db = freshDb();
    const now = Date.now();
    insertItem(db, {
      id: "gh:2",
      service: "github",
      type: "pr",
      modifiedAt: now,
      chunkText: "pr text",
      rowid: 1,
      model: "openai:text-embedding-3-small",
    });
    const v = new Float32Array(1536);
    v[0] = 1;
    const hits = vectorSearchChunks(db, {
      queryEmbedding: v,
      model: "openai:text-embedding-3-small",
      limit: 10,
      itemType: "",
    });
    // empty string → no type filter applied → item is returned
    expect(hits).toHaveLength(1);
    expect(hits[0]?.itemId).toBe("gh:2");
  });

  test.skipIf(!VEC_AVAILABLE)("itemType filter — matching type returns item", () => {
    const db = freshDb();
    const now = Date.now();
    insertItem(db, {
      id: "gh:3",
      service: "github",
      type: "issue",
      modifiedAt: now,
      chunkText: "issue text",
      rowid: 1,
      model: "openai:text-embedding-3-small",
    });
    insertItem(db, {
      id: "gh:4",
      service: "github",
      type: "pr",
      modifiedAt: now,
      chunkText: "pr text",
      rowid: 2,
      model: "openai:text-embedding-3-small",
    });
    const v = new Float32Array(1536);
    v[0] = 1;
    const hits = vectorSearchChunks(db, {
      queryEmbedding: v,
      model: "openai:text-embedding-3-small",
      limit: 10,
      itemType: "issue",
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.itemId).toBe("gh:3");
  });

  test.skipIf(!VEC_AVAILABLE)("itemType filter — non-matching type returns empty", () => {
    const db = freshDb();
    const now = Date.now();
    insertItem(db, {
      id: "gh:5",
      service: "github",
      type: "issue",
      modifiedAt: now,
      chunkText: "issue text",
      rowid: 1,
      model: "openai:text-embedding-3-small",
    });
    const v = new Float32Array(1536);
    v[0] = 1;
    const hits = vectorSearchChunks(db, {
      queryEmbedding: v,
      model: "openai:text-embedding-3-small",
      limit: 10,
      itemType: "pr",
    });
    expect(hits).toHaveLength(0);
  });

  test.skipIf(!VEC_AVAILABLE)("since filter — since=0 is treated as no filter", () => {
    const db = freshDb();
    const now = Date.now();
    insertItem(db, {
      id: "i:1",
      service: "github",
      type: "issue",
      modifiedAt: now - 100_000,
      chunkText: "old item",
      rowid: 1,
      model: "openai:text-embedding-3-small",
    });
    const v = new Float32Array(1536);
    v[0] = 1;
    const hits = vectorSearchChunks(db, {
      queryEmbedding: v,
      model: "openai:text-embedding-3-small",
      limit: 10,
      since: 0,
    });
    // since=0 → no filter applied (since > 0 is false) → item is returned
    expect(hits).toHaveLength(1);
    expect(hits[0]?.itemId).toBe("i:1");
  });

  test.skipIf(!VEC_AVAILABLE)("since filter — negative since is treated as no filter", () => {
    const db = freshDb();
    const now = Date.now();
    insertItem(db, {
      id: "i:neg",
      service: "github",
      type: "issue",
      modifiedAt: now - 100_000,
      chunkText: "old item",
      rowid: 1,
      model: "openai:text-embedding-3-small",
    });
    const v = new Float32Array(1536);
    v[0] = 1;
    const hits = vectorSearchChunks(db, {
      queryEmbedding: v,
      model: "openai:text-embedding-3-small",
      limit: 10,
      since: -1,
    });
    // since=-1 → since > 0 is false → no filter applied → item returned
    expect(hits).toHaveLength(1);
    expect(hits[0]?.itemId).toBe("i:neg");
  });

  test.skipIf(!VEC_AVAILABLE)("since filter — recent items pass filter", () => {
    const db = freshDb();
    const now = Date.now();
    const threshold = now - 60_000; // 1 minute ago
    insertItem(db, {
      id: "new:1",
      service: "github",
      type: "issue",
      modifiedAt: now, // after threshold
      chunkText: "new item",
      rowid: 1,
      model: "openai:text-embedding-3-small",
    });
    insertItem(db, {
      id: "old:1",
      service: "github",
      type: "issue",
      modifiedAt: now - 120_000, // 2 min ago, before threshold
      chunkText: "old item",
      rowid: 2,
      model: "openai:text-embedding-3-small",
    });
    const v = new Float32Array(1536);
    v[0] = 1;
    const hits = vectorSearchChunks(db, {
      queryEmbedding: v,
      model: "openai:text-embedding-3-small",
      limit: 10,
      since: threshold,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.itemId).toBe("new:1");
  });

  test.skipIf(!VEC_AVAILABLE)("since filter — old items excluded", () => {
    const db = freshDb();
    const now = Date.now();
    insertItem(db, {
      id: "old:2",
      service: "github",
      type: "issue",
      modifiedAt: now - 200_000,
      chunkText: "old item",
      rowid: 1,
      model: "openai:text-embedding-3-small",
    });
    const v = new Float32Array(1536);
    v[0] = 1;
    const hits = vectorSearchChunks(db, {
      queryEmbedding: v,
      model: "openai:text-embedding-3-small",
      limit: 10,
      since: now - 100_000, // threshold in the middle
    });
    expect(hits).toHaveLength(0);
  });

  test.skipIf(!VEC_AVAILABLE)("combined filters — service + itemType + since all applied", () => {
    const db = freshDb();
    const now = Date.now();
    const threshold = now - 60_000;
    // Matches all filters
    insertItem(db, {
      id: "match:1",
      service: "github",
      type: "issue",
      modifiedAt: now,
      chunkText: "match",
      rowid: 1,
      model: "openai:text-embedding-3-small",
    });
    // Wrong service
    insertItem(db, {
      id: "wrong-svc:2",
      service: "slack",
      type: "issue",
      modifiedAt: now,
      chunkText: "wrong svc",
      rowid: 2,
      model: "openai:text-embedding-3-small",
    });
    // Wrong type
    insertItem(db, {
      id: "wrong-type:3",
      service: "github",
      type: "pr",
      modifiedAt: now,
      chunkText: "wrong type",
      rowid: 3,
      model: "openai:text-embedding-3-small",
    });
    // Too old
    insertItem(db, {
      id: "too-old:4",
      service: "github",
      type: "issue",
      modifiedAt: now - 200_000,
      chunkText: "too old",
      rowid: 4,
      model: "openai:text-embedding-3-small",
    });
    const v = new Float32Array(1536);
    v[0] = 1;
    const hits = vectorSearchChunks(db, {
      queryEmbedding: v,
      model: "openai:text-embedding-3-small",
      limit: 10,
      service: "github",
      itemType: "issue",
      since: threshold,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.itemId).toBe("match:1");
  });

  test.skipIf(!VEC_AVAILABLE)("limit is clamped to minimum of 1", () => {
    const db = freshDb();
    const now = Date.now();
    insertItem(db, {
      id: "lim:1",
      service: "github",
      type: "issue",
      modifiedAt: now,
      chunkText: "item",
      rowid: 1,
      model: "openai:text-embedding-3-small",
    });
    const v = new Float32Array(1536);
    v[0] = 1;
    // limit=0 → Math.max(1, 0) = 1 → still returns up to 1 result
    const hits = vectorSearchChunks(db, {
      queryEmbedding: v,
      model: "openai:text-embedding-3-small",
      limit: 0,
    });
    expect(hits).toHaveLength(1);
  });

  test.skipIf(!VEC_AVAILABLE)("limit is clamped to maximum of 500", () => {
    const db = freshDb();
    const now = Date.now();
    // Seed more than 500 matching rows so the cap is observable: without the
    // Math.min(500, limit) clamp, limit=99999 would return all 501.
    const total = 501;
    for (let i = 1; i <= total; i++) {
      insertItem(db, {
        id: `clamp:${String(i)}`,
        service: "svc",
        type: "file",
        modifiedAt: now,
        chunkText: "c",
        rowid: i,
        model: "openai:text-embedding-3-small",
      });
    }
    const v = new Float32Array(1536);
    v[0] = 1;
    const hits = vectorSearchChunks(db, {
      queryEmbedding: v,
      model: "openai:text-embedding-3-small",
      limit: 99999,
    });
    // 501 rows available but the result is capped at the 500 ceiling.
    expect(hits).toHaveLength(500);
  });

  test.skipIf(!VEC_AVAILABLE)("hit shape exposes all VectorChunkHit fields", () => {
    const db = freshDb();
    const now = Date.now();
    insertItem(db, {
      id: "shape:1",
      service: "github",
      type: "issue",
      modifiedAt: now,
      chunkText: "chunk content here",
      rowid: 42,
      model: "openai:text-embedding-3-small",
    });
    const v = new Float32Array(1536);
    v[0] = 1;
    const hits = vectorSearchChunks(db, {
      queryEmbedding: v,
      model: "openai:text-embedding-3-small",
      limit: 5,
    });
    expect(hits).toHaveLength(1);
    const hit = hits[0];
    if (hit === undefined) throw new Error("expected a hit");
    expect(hit.itemId).toBe("shape:1");
    expect(hit.chunkIndex).toBe(0);
    expect(hit.chunkText).toBe("chunk content here");
    expect(hit.vecRowid).toBe(42);
    expect(typeof hit.distance).toBe("number");
  });

  test.skipIf(!VEC_AVAILABLE)("384-dim embedding uses vec_items_384 table", () => {
    const db = freshDb();
    const now = Date.now();
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at)
       VALUES ('local:1', 'local', 'note', 'local:1', 'T', 'B', ?, ?)`,
      [now, now],
    );
    const v = new Float32Array(384);
    v[0] = 1;
    db.run(`INSERT INTO vec_items_384 (rowid, embedding) VALUES (1, vec_f32(?))`, [v]);
    db.run(
      `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
       VALUES ('local:1', 0, 'local note', 1, 'local:minilm', 384, ?)`,
      [now],
    );
    const hits = vectorSearchChunks(db, {
      queryEmbedding: v,
      model: "local:minilm",
      limit: 5,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.itemId).toBe("local:1");
  });
});
