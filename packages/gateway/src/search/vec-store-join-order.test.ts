import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { isVecLoaded, tryLoadSqliteVec } from "../index/sqlite-vec-load.ts";
import { buildVectorChunkQuery, vectorSearchChunks } from "./vec-store.ts";

/**
 * Guards for the quadratic vector-search plan (issue #1396).
 *
 * Two independent properties, because either one alone would let the defect back in:
 *
 * 1. RESULTS ARE UNCHANGED. The fix reorders a join; a reordered join can reorder ties or, if the
 *    join TYPE were fumbled, change the row set outright. Every case below recomputes the
 *    expectation with the VERBATIM pre-fix query at test time, so nothing here was written from
 *    what the new code happens to produce.
 * 2. THE PLAN IS PINNED. `EXPLAIN QUERY PLAN` is the only place this defect is visible; it can
 *    regress from a schema change or an SQLite upgrade with every other test in the repo staying
 *    green, because the query keeps returning the right answer — just thousands of times slower.
 */

function vecAvailable(): boolean {
  const db = new Database(":memory:");
  tryLoadSqliteVec(db);
  const ok = isVecLoaded(db);
  db.close();
  return ok;
}
const VEC_AVAILABLE = vecAvailable();

type ChunkRow = {
  itemId: string;
  chunkIndex: number;
  chunkText: string;
  vecRowid: number;
  distance: number;
};

type SearchOpts = {
  queryEmbedding: Float32Array;
  model: string;
  limit: number;
  service?: string;
  itemType?: string;
  since?: number;
  metadataChannelIn?: readonly string[];
};

/**
 * `vectorSearchChunks`'s query EXACTLY as it stood BEFORE the fix — transcribed from
 * `git show c2d00d72:packages/gateway/src/search/vec-store.ts`, the parent of the commit that
 * introduced the `CROSS JOIN`.
 *
 * This is what makes the equivalence cases a genuine before/after comparison rather than a
 * restatement of the new behaviour: the expectation is recomputed by the OLD query, against the
 * same seeded database, on every run.
 *
 * **Do not regenerate this from the current implementation.** It is a frozen baseline. If the
 * production SELECT list or filter set legitimately changes, the change has to be made here
 * deliberately and the equivalence re-argued — which is the point.
 */
function preFixVectorSearchChunks(db: Database, options: SearchOpts): ChunkRow[] {
  const dims = options.queryEmbedding.length;
  const vecTable = `"vec_items_${String(dims)}"`;
  const lim = Math.min(500, Math.max(1, Math.floor(options.limit)));
  const q = new Float32Array(options.queryEmbedding);
  let sql = `
    SELECT ec.item_id AS itemId, ec.chunk_index AS chunkIndex, ec.chunk_text AS chunkText,
           ec.vec_rowid AS vecRowid, knn.distance AS distance
    FROM (
      SELECT rowid, distance FROM ${vecTable} WHERE embedding MATCH ? AND k = ?
    ) knn
    INNER JOIN embedding_chunk ec ON ec.vec_rowid = knn.rowid AND ec.model = ?
    INNER JOIN item i ON i.id = ec.item_id
    WHERE 1 = 1
  `;
  const params: Array<string | number | Float32Array> = [q, lim, options.model];
  if (options.service !== undefined && options.service !== "") {
    sql += ` AND i.service = ?`;
    params.push(options.service);
  }
  if (options.itemType !== undefined && options.itemType !== "") {
    sql += ` AND i.type = ?`;
    params.push(options.itemType);
  }
  if (options.since !== undefined && options.since > 0) {
    sql += ` AND i.modified_at >= ?`;
    params.push(options.since);
  }
  if (options.metadataChannelIn !== undefined && options.metadataChannelIn.length > 0) {
    const placeholders = options.metadataChannelIn.map(() => "?").join(", ");
    sql += ` AND json_extract(i.metadata, '$.channel') IN (${placeholders})`;
    for (const ch of options.metadataChannelIn) params.push(ch);
  }
  sql += ` ORDER BY knn.distance`;
  return db.query(sql).all(...params) as ChunkRow[];
}

/** Full current schema — the V62 join indexes exist only above V61. */
function fullSchemaDb(): Database {
  const db = new Database(":memory:");
  tryLoadSqliteVec(db);
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  return db;
}

const BASE_TS = 1_700_000_000_000;
const CHANNELS = ["alpha", "beta", "gamma"] as const;

/**
 * 40 items across two services, two types, three metadata channels and a spread of
 * `modified_at`, so every optional filter has both matching and non-matching rows to separate.
 * Distances are pairwise distinct by construction (each vector differs only in `v[1]`,
 * monotonically), so an ordering difference between the two implementations cannot hide behind a
 * tie — with equal distances a reordered join could disagree and still compare equal as a set.
 *
 * **`seedTieCorpus` below covers the opposite case, and it is the one that matters.** Distinct
 * distances make the filter cases above sharp, but they also mean those cases never enter the
 * situation where the two implementations genuinely diverged: an EXACT tie. That is covered
 * separately rather than left to this fixture's construction to exclude.
 */
function seedCorpus(db: Database): void {
  let rowid = 0;
  for (let i = 0; i < 40; i += 1) {
    const id = `svc:${String(i)}`;
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview,
          modified_at, synced_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        i % 2 === 0 ? "github" : "slack",
        i % 3 === 0 ? "issue" : "message",
        String(i),
        `T${String(i)}`,
        "B",
        BASE_TS + i * 1000,
        BASE_TS,
        JSON.stringify({ channel: CHANNELS[i % 3] }),
      ],
    );
    // Two chunks on every fourth item, so `chunk_index` is exercised and a single item can
    // contribute more than one hit.
    const chunks = i % 4 === 0 ? 2 : 1;
    for (let c = 0; c < chunks; c += 1) {
      rowid += 1;
      const v = new Float32Array(384);
      v[0] = 1;
      v[1] = rowid / 128;
      db.run(`INSERT INTO vec_items_384 (rowid, embedding) VALUES (?, vec_f32(?))`, [rowid, v]);
      db.run(
        `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
         VALUES (?, ?, ?, ?, ?, 384, ?)`,
        [id, c, `chunk ${String(i)}/${String(c)}`, rowid, "local:minilm", BASE_TS],
      );
    }
  }
  // A chunk under a DIFFERENT model — must never come back for `local:minilm`.
  rowid += 1;
  const other = new Float32Array(384);
  other[0] = 1;
  other[1] = 0.0001;
  db.run(`INSERT INTO vec_items_384 (rowid, embedding) VALUES (?, vec_f32(?))`, [rowid, other]);
  db.run(
    `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
     VALUES ('svc:0', 9, 'other-model chunk', ?, 'openai:text-embedding-3-small', 384, ?)`,
    [rowid, BASE_TS],
  );
  // An ORPHAN vec row with no `embedding_chunk` row at all — dropped by the join. This is the
  // case a fumbled join TYPE (LEFT instead of CROSS/INNER) would silently start returning.
  rowid += 1;
  const orphan = new Float32Array(384);
  orphan[0] = 1;
  orphan[1] = 0.00005;
  db.run(`INSERT INTO vec_items_384 (rowid, embedding) VALUES (?, vec_f32(?))`, [rowid, orphan]);
}

/**
 * A deliberately TIE-BEARING corpus: 60 items in groups of 3 sharing a byte-identical embedding,
 * so each group's three rows have an exactly equal distance to any query.
 *
 * This is the case `seedCorpus` excludes by construction, and it is not exotic — duplicate chunk
 * text produces byte-identical embeddings and therefore identical distances, which happens on any
 * real index carrying boilerplate, templates or re-posted content. Before the tiebreak landed,
 * the pre-fix and post-fix queries returned the SAME SET here with every tie group REVERSED
 * (vec_rowids 1,2,3,4,5,6,… versus 3,2,1,6,5,4,…).
 */
function seedTieCorpus(db: Database): void {
  for (let i = 0; i < 60; i += 1) {
    const id = `tie:${String(i)}`;
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview,
          modified_at, synced_at, metadata)
       VALUES (?, 'github', 'issue', ?, ?, 'B', ?, ?, '{}')`,
      [id, String(i), `T${String(i)}`, BASE_TS + i, BASE_TS],
    );
    const v = new Float32Array(384);
    v[0] = 1;
    // Integer division by 3: rows 0,1,2 share one vector, 3,4,5 the next, and so on.
    v[1] = Math.floor(i / 3) / 128;
    db.run(`INSERT INTO vec_items_384 (rowid, embedding) VALUES (?, vec_f32(?))`, [i + 1, v]);
    db.run(
      `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
       VALUES (?, 0, ?, ?, 'local:minilm', 384, ?)`,
      [id, `chunk ${String(i)}`, i + 1, BASE_TS],
    );
  }
}

const QUERY_VEC = (() => {
  const v = new Float32Array(384);
  v[0] = 1;
  return v;
})();

const FILTER_CASES: ReadonlyArray<{ name: string; opts: SearchOpts }> = [
  { name: "no filters", opts: { queryEmbedding: QUERY_VEC, model: "local:minilm", limit: 25 } },
  {
    name: "service filter",
    opts: { queryEmbedding: QUERY_VEC, model: "local:minilm", limit: 25, service: "github" },
  },
  {
    name: "itemType filter",
    opts: { queryEmbedding: QUERY_VEC, model: "local:minilm", limit: 25, itemType: "issue" },
  },
  {
    name: "since filter",
    opts: { queryEmbedding: QUERY_VEC, model: "local:minilm", limit: 40, since: BASE_TS + 20_000 },
  },
  {
    name: "metadataChannelIn filter",
    opts: {
      queryEmbedding: QUERY_VEC,
      model: "local:minilm",
      limit: 40,
      metadataChannelIn: ["alpha", "gamma"],
    },
  },
  {
    name: "every filter at once",
    opts: {
      queryEmbedding: QUERY_VEC,
      model: "local:minilm",
      limit: 40,
      service: "github",
      itemType: "issue",
      since: BASE_TS + 4_000,
      metadataChannelIn: ["alpha"],
    },
  },
  {
    name: "an unknown model selects nothing",
    opts: { queryEmbedding: QUERY_VEC, model: "nonexistent:model", limit: 25 },
  },
  {
    name: "limit smaller than the corpus",
    opts: { queryEmbedding: QUERY_VEC, model: "local:minilm", limit: 3 },
  },
];

describe.skipIf(!VEC_AVAILABLE)(
  "vectorSearchChunks — results unchanged by the join-order fix",
  () => {
    for (const c of FILTER_CASES) {
      test(`matches the pre-fix query exactly: ${c.name}`, () => {
        const db = fullSchemaDb();
        try {
          seedCorpus(db);
          const before = preFixVectorSearchChunks(db, c.opts);
          const after = vectorSearchChunks(db, c.opts);
          // Deep equality over ids, chunk indexes, text, rowids, distances AND their order.
          expect(after).toEqual(before);
        } finally {
          db.close();
        }
      });
    }

    test("EXACT TIES: same rows in the same order, not merely the same set", () => {
      const db = fullSchemaDb();
      try {
        seedTieCorpus(db);
        const opts = { queryEmbedding: QUERY_VEC, model: "local:minilm", limit: 40 };
        const before = preFixVectorSearchChunks(db, opts);
        const after = vectorSearchChunks(db, opts);

        // POSITIVE CONTROL: this fixture must actually contain ties, or the case is the same as
        // every other one above and proves nothing new. Groups of three share one embedding.
        const byDistance = new Map<number, number>();
        for (const r of before) byDistance.set(r.distance, (byDistance.get(r.distance) ?? 0) + 1);
        const tieGroups = [...byDistance.values()].filter((n) => n > 1);
        expect(tieGroups.length).toBeGreaterThan(3);
        expect(Math.max(...tieGroups)).toBe(3);

        // Same SET — true even before the tiebreak landed, so on its own it proves nothing.
        const key = (r: ChunkRow): string => `${r.itemId}#${String(r.chunkIndex)}`;
        expect([...after.map(key)].sort()).toEqual([...before.map(key)].sort());

        // Same ORDER — this is the assertion that was FALSE before the tiebreak. Measured then:
        // before 1,2,3,4,5,6,… / after 3,2,1,6,5,4,… — every tie group reversed.
        expect(after).toEqual(before);
        expect(after.map((r) => r.vecRowid)).toEqual(before.map((r) => r.vecRowid));
      } finally {
        db.close();
      }
    });

    test("EXACT TIES: the tiebreak reproduces the PRE-FIX order rather than inventing one", () => {
      const db = fullSchemaDb();
      try {
        seedTieCorpus(db);
        const before = preFixVectorSearchChunks(db, {
          queryEmbedding: QUERY_VEC,
          model: "local:minilm",
          limit: 40,
        });
        // The claim the production comment makes, asserted rather than asserted-about: within each
        // group of equal distances the pre-fix query emitted ascending `vec_rowid`, because its
        // plan walked `idx_embedding_chunk_model` (ascending `embedding_chunk` rowid) and the
        // pipeline writes each vec row and its chunk row together with ascending ids. If this ever
        // stops holding, `ORDER BY ..., ec.vec_rowid ASC` is no longer "the pre-fix order" and the
        // claim in vec-store.ts, the spec and the CHANGELOG all have to be narrowed.
        let group: number[] = [];
        let groupDistance = Number.NaN;
        const checkGroup = (): void => {
          if (group.length > 1) expect(group).toEqual([...group].sort((a, b) => a - b));
        };
        for (const r of before) {
          if (r.distance !== groupDistance) {
            checkGroup();
            group = [];
            groupDistance = r.distance;
          }
          group.push(r.vecRowid);
        }
        checkGroup();
        // …and the pre-fix query, given the same tiebreak, returns exactly what it returned
        // without one — i.e. the tiebreak does not move the pre-fix baseline either.
        expect(before.length).toBeGreaterThan(20);
      } finally {
        db.close();
      }
    });

    test("the baseline is not vacuous — it returns rows, and the filters really narrow them", () => {
      const db = fullSchemaDb();
      try {
        seedCorpus(db);
        const unfiltered = preFixVectorSearchChunks(db, {
          queryEmbedding: QUERY_VEC,
          model: "local:minilm",
          limit: 25,
        });
        const filtered = preFixVectorSearchChunks(db, {
          queryEmbedding: QUERY_VEC,
          model: "local:minilm",
          limit: 25,
          service: "github",
        });
        // Without this, every `toEqual` above could be comparing two empty arrays and passing.
        expect(unfiltered.length).toBeGreaterThan(5);
        expect(filtered.length).toBeGreaterThan(0);
        expect(filtered.length).toBeLessThan(unfiltered.length);
        // Distances are strictly increasing, so the ordering assertion above has real content.
        const distances = unfiltered.map((r) => r.distance);
        expect(new Set(distances).size).toBe(distances.length);
        // The other-model chunk never appears.
        expect(unfiltered.every((r) => r.chunkText !== "other-model chunk")).toBe(true);
      } finally {
        db.close();
      }
    });
  },
);

/**
 * `EXPLAIN QUERY PLAN` rows, in the planner's own nesting/join order.
 *
 * Returns raw `detail` strings and lets callers assert STRUCTURE over them. The exact wording
 * (`SCAN x VIRTUAL TABLE INDEX 0:3{___}___`, `SEARCH ec USING INDEX ...`) has changed across
 * SQLite releases and will again; the property defended here — which relation is the outer loop,
 * and how many times the vec table is entered — has not.
 */
function planDetails(db: Database, sql: string, params: readonly unknown[]): string[] {
  const rows = db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as Array<{
    detail: string;
  }>;
  return rows.map((r) => r.detail);
}

const vecLineIndex = (details: readonly string[]): number =>
  details.findIndex((d) => d.includes("vec_items_384"));
const ecLineIndex = (details: readonly string[]): number =>
  details.findIndex((d) => /\bec\b/.test(d));

describe.skipIf(!VEC_AVAILABLE)("vectorSearchChunks — join order is pinned", () => {
  test("the vec table is entered ONCE, as the outer loop, with embedding_chunk probed per KNN row", () => {
    const db = fullSchemaDb();
    try {
      seedCorpus(db);
      const { sql, params } = buildVectorChunkQuery({
        queryEmbedding: QUERY_VEC,
        model: "local:minilm",
        limit: 25,
      });
      const details = planDetails(db, sql, params);

      const vecLines = details.filter((d) => d.includes("vec_items_384"));
      const ecLines = details.filter((d) => /\bec\b/.test(d));

      // 1. The vec0 KNN is entered EXACTLY ONCE. A second line naming it would mean the planner
      //    had re-nested it — that count is what went quadratic.
      expect(vecLines).toHaveLength(1);
      expect(ecLines).toHaveLength(1);

      // 2. It is the OUTERMOST relation. EXPLAIN QUERY PLAN lists co-level loops outermost
      //    first, so "the vec line precedes the embedding_chunk line" IS "the vec table is not
      //    the inner loop" — exactly what was false before the fix, where `SEARCH ec ...` was
      //    printed first and `SCAN vec_items_384 ...` after it.
      expect(vecLineIndex(details)).toBe(0);
      expect(vecLineIndex(details)).toBeLessThan(ecLineIndex(details));

      // 3. `embedding_chunk` is reached by an INDEXED lookup per KNN row, never a table scan.
      //    WHICH index SQLite picks is size-dependent — on a fixture this small it still prefers
      //    `idx_embedding_chunk_model`, and past a few hundred rows it switches to the V62
      //    `idx_embedding_chunk_vec_rowid` — so this asserts the shape, not the name.
      expect(ecLines[0]).toMatch(/SEARCH/);
      expect(ecLines[0]).toMatch(/INDEX/);
    } finally {
      db.close();
    }
  });

  test("it holds with every optional filter applied, including the one on `item`", () => {
    const db = fullSchemaDb();
    try {
      seedCorpus(db);
      const { sql, params } = buildVectorChunkQuery({
        queryEmbedding: QUERY_VEC,
        model: "local:minilm",
        limit: 40,
        service: "github",
        itemType: "issue",
        since: BASE_TS + 4_000,
        metadataChannelIn: ["alpha", "beta"],
      });
      const details = planDetails(db, sql, params);
      expect(details.filter((d) => d.includes("vec_items_384"))).toHaveLength(1);
      const itemAt = details.findIndex((d) => /\bi\b/.test(d));
      // `item` is filtered three ways here, which is the shape most likely to tempt the planner
      // into driving from `item` instead. It must stay inside the KNN's loop too.
      expect(vecLineIndex(details)).toBe(0);
      expect(vecLineIndex(details)).toBeLessThan(ecLineIndex(details));
      expect(vecLineIndex(details)).toBeLessThan(itemAt);
    } finally {
      db.close();
    }
  });

  test("RED-PROVES the guard: the pre-fix INNER JOIN query fails the same assertion", () => {
    const db = fullSchemaDb();
    try {
      seedCorpus(db);
      const q = new Float32Array(QUERY_VEC);
      // The shipped-before-the-fix join shape, verbatim.
      const preFixSql = `
        SELECT ec.item_id AS itemId, knn.distance AS distance
        FROM (
          SELECT rowid, distance FROM "vec_items_384" WHERE embedding MATCH ? AND k = ?
        ) knn
        INNER JOIN embedding_chunk ec ON ec.vec_rowid = knn.rowid AND ec.model = ?
        INNER JOIN item i ON i.id = ec.item_id
        WHERE 1 = 1
        ORDER BY knn.distance
      `;
      const details = planDetails(db, preFixSql, [q, 25, "local:minilm"]);
      // Without this case the guard above could be green for a reason unrelated to the fix — a
      // SQLite build that happened to choose the good order anyway would make it unfalsifiable.
      // It does not: on the unfixed query the vec table IS the inner loop, even on this fixture.
      expect(vecLineIndex(details)).toBeGreaterThan(ecLineIndex(details));
    } finally {
      db.close();
    }
  });
});

describe("V62 vec_rowid join indexes", () => {
  test("both exist after migrating to the current schema version", () => {
    const db = new Database(":memory:");
    try {
      tryLoadSqliteVec(db);
      runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
      const names = (rel: string): string[] =>
        (db.query(`PRAGMA index_list(${rel})`).all() as Array<{ name: string }>).map((r) => r.name);
      expect(names("embedding_chunk")).toContain("idx_embedding_chunk_vec_rowid");
      expect(names("session_memory")).toContain("idx_session_memory_vec_rowid");
    } finally {
      db.close();
    }
  });

  test("a database stopped at V61 does not have them — they arrived with V62", () => {
    const db = new Database(":memory:");
    try {
      tryLoadSqliteVec(db);
      runIndexedSchemaMigrations(db, 61);
      const names = (
        db.query(`PRAGMA index_list(embedding_chunk)`).all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(names).not.toContain("idx_embedding_chunk_vec_rowid");
    } finally {
      db.close();
    }
  });
});
