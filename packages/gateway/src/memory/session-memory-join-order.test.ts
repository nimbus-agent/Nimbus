import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { LocalIndex } from "../index/local-index.ts";
import { isVecLoaded, tryLoadSqliteVec } from "../index/sqlite-vec-load.ts";
import { SESSION_RECALL_SQL, SessionMemoryStore } from "./session-memory-store.ts";

/**
 * The session-memory half of the quadratic vector-search fix (issue #1396).
 *
 * `SessionMemoryStore.recall` joins the same sqlite-vec KNN subquery to an ordinary table, and it
 * was affected in exactly the same way — measured here rather than assumed to transfer from
 * `search/vec-store.ts`. It is arguably the worse of the two: `session_memory` shares
 * `vec_items_384` with `embedding_chunk`, so the pre-fix cost of one recall scaled with the size
 * of the user's WHOLE index multiplied by the number of turns in the conversation. Measured at
 * 8,000 indexed vectors and 2,000 session turns: 42.4s before, 27.8ms after.
 */

function vecAvailable(): boolean {
  const db = new Database(":memory:");
  tryLoadSqliteVec(db);
  const ok = isVecLoaded(db);
  db.close();
  return ok;
}
const VEC_AVAILABLE = vecAvailable();

/** The pre-fix recall query, verbatim from `git show c2d00d72:.../session-memory-store.ts`. */
const PRE_FIX_RECALL_SQL = `
      SELECT sm.chunk_text AS chunkText, sm.role AS role, sm.created_at AS createdAt, knn.distance AS distance
      FROM (
        SELECT rowid, distance FROM vec_items_384 WHERE embedding MATCH ? AND k = ?
      ) knn
      INNER JOIN session_memory sm ON sm.vec_rowid = knn.rowid
      WHERE sm.session_id = ?
      ORDER BY knn.distance
      LIMIT ?
`;

const BASE_TS = 1_700_000_000_000;

/**
 * Two sessions plus a block of unrelated `embedding_chunk`-owned vectors, so the recall query has
 * to discriminate on `session_id` AND on `vec_rowid` — and so the vec table holds rows that belong
 * to neither session, which is the production shape the two stores share.
 */
function seed(db: Database): void {
  let rowid = 0;
  const vec = (n: number): Float32Array => {
    const v = new Float32Array(384);
    v[0] = 1;
    v[1] = n / 512;
    return v;
  };
  // Index-owned vectors — no session_memory row points at these.
  for (let i = 0; i < 30; i += 1) {
    rowid += 1;
    db.run(`INSERT INTO vec_items_384 (rowid, embedding) VALUES (?, vec_f32(?))`, [
      rowid,
      vec(rowid),
    ]);
  }
  for (const sid of ["sess-a", "sess-b"]) {
    for (let t = 0; t < 20; t += 1) {
      rowid += 1;
      db.run(`INSERT INTO vec_items_384 (rowid, embedding) VALUES (?, vec_f32(?))`, [
        rowid,
        vec(rowid),
      ]);
      db.run(
        `INSERT INTO session_memory (session_id, chunk_text, vec_rowid, role, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [sid, `${sid} turn ${String(t)}`, rowid, t % 2 === 0 ? "user" : "assistant", BASE_TS + t],
      );
    }
  }
}

function freshDb(): Database {
  const db = new Database(":memory:");
  tryLoadSqliteVec(db);
  LocalIndex.ensureSchema(db);
  return db;
}

const QUERY_VEC = (() => {
  const v = new Float32Array(384);
  v[0] = 1;
  return v;
})();

function planDetails(db: Database, sql: string, params: readonly unknown[]): string[] {
  return (
    db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as Array<{ detail: string }>
  ).map((r) => r.detail);
}

const vecAt = (details: readonly string[]): number =>
  details.findIndex((d) => d.includes("vec_items_384"));
const smAt = (details: readonly string[]): number => details.findIndex((d) => /\bsm\b/.test(d));

describe.skipIf(!VEC_AVAILABLE)("SessionMemoryStore.recall — results unchanged by the fix", () => {
  for (const [k, lim] of [
    [8, 32],
    [32, 128],
    [1, 4],
  ] as const) {
    test(`matches the pre-fix query exactly (k=${String(k)}, lim=${String(lim)})`, () => {
      const db = freshDb();
      try {
        seed(db);
        const before = db.query(PRE_FIX_RECALL_SQL).all(QUERY_VEC, lim, "sess-a", k);
        const after = db.query(SESSION_RECALL_SQL).all(QUERY_VEC, lim, "sess-a", k);
        expect(after).toEqual(before);
      } finally {
        db.close();
      }
    });
  }

  test("the baseline is not vacuous, and the session filter really discriminates", () => {
    const db = freshDb();
    try {
      seed(db);
      const a = db.query(PRE_FIX_RECALL_SQL).all(QUERY_VEC, 128, "sess-a", 32) as Array<{
        chunkText: string;
      }>;
      const b = db.query(PRE_FIX_RECALL_SQL).all(QUERY_VEC, 128, "sess-b", 32) as Array<{
        chunkText: string;
      }>;
      // Without this, the equality cases above could be comparing two empty arrays.
      expect(a.length).toBeGreaterThan(0);
      expect(b.length).toBeGreaterThan(0);
      expect(a.every((r) => r.chunkText.startsWith("sess-a"))).toBe(true);
      expect(b.every((r) => r.chunkText.startsWith("sess-b"))).toBe(true);
    } finally {
      db.close();
    }
  });

  test("the store's own recall path still returns session-scoped hits", async () => {
    const db = freshDb();
    try {
      const store = new SessionMemoryStore({
        db,
        dims: 384,
        embedText: async (t: string) => {
          const v = new Float32Array(384);
          v[0] = 1;
          v[1] = t.includes("payment") ? 0 : 0.5;
          return v;
        },
      });
      await store.append({
        sessionId: "s1",
        text: "payment service rollout",
        role: "user",
        createdAt: BASE_TS,
      });
      await store.append({
        sessionId: "s2",
        text: "payment service rollback",
        role: "user",
        createdAt: BASE_TS,
      });
      const hits = await store.recall("s1", "payment", 8);
      expect(hits).toHaveLength(1);
      expect(hits[0]?.chunkText).toBe("payment service rollout");
    } finally {
      db.close();
    }
  });
});

describe.skipIf(!VEC_AVAILABLE)("SessionMemoryStore.recall — join order is pinned", () => {
  test("the vec table is entered once, as the outer loop, with session_memory probed per KNN row", () => {
    const db = freshDb();
    try {
      seed(db);
      const details = planDetails(db, SESSION_RECALL_SQL, [QUERY_VEC, 128, "sess-a", 32]);
      expect(details.filter((d) => d.includes("vec_items_384"))).toHaveLength(1);
      expect(vecAt(details)).toBe(0);
      expect(vecAt(details)).toBeLessThan(smAt(details));
      const smLine = details[smAt(details)] ?? "";
      // Indexed probe per KNN row, not a scan. Which index is size-dependent (a small fixture
      // still prefers `idx_session_memory_session`; at scale it takes the V62
      // `idx_session_memory_vec_rowid`), so this asserts the shape, not the name.
      expect(smLine).toMatch(/SEARCH/);
      expect(smLine).toMatch(/INDEX/);
    } finally {
      db.close();
    }
  });

  test("RED-PROVES the guard: the pre-fix INNER JOIN query fails the same assertion", () => {
    const db = freshDb();
    try {
      seed(db);
      const details = planDetails(db, PRE_FIX_RECALL_SQL, [QUERY_VEC, 128, "sess-a", 32]);
      // `WHERE sm.session_id = ?` is selective, so the planner drives from `session_memory` and
      // re-runs the KNN once per turn. That is the defect, still reproducible on this fixture.
      expect(vecAt(details)).toBeGreaterThan(smAt(details));
    } finally {
      db.close();
    }
  });
});
