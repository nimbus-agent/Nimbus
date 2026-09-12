import type { Database } from "bun:sqlite";

import { dbRun } from "../db/write.ts";
import { readIndexedUserVersion } from "../index/migrations/runner.ts";
import { ensureSqliteVecForConnection } from "../index/sqlite-vec-load.ts";

export type SessionMemoryRole = "user" | "assistant" | "tool";

export type SessionChunk = {
  sessionId: string;
  text: string;
  role: SessionMemoryRole;
  createdAt: number;
};

export type SessionMemoryRecallHit = {
  chunkText: string;
  role: SessionMemoryRole;
  createdAt: number;
  distance: number;
};

export type SessionMemoryStoreDeps = {
  db: Database;
  dims: number;
  embedText: (text: string) => Promise<Float32Array | null>;
};

/**
 * The recall query, at module scope so the query-plan regression test can `EXPLAIN QUERY PLAN` the
 * string PRODUCTION runs rather than a transcription of it that could stay green while this file
 * regressed.
 *
 * CROSS JOIN, not INNER JOIN — the same defect and the same fix as `search/vec-store.ts`, measured
 * separately here rather than assumed to transfer. `WHERE sm.session_id = ?` makes the planner's
 * wrong choice look MORE attractive, not less: `idx_session_memory_session` is selective, so left
 * to itself SQLite drives from `session_memory` and re-runs the brute-force KNN once per turn in
 * the session — over the WHOLE `vec_items_384` table, which this store SHARES with
 * `embedding_chunk`, so the per-turn cost scales with the size of the user's entire index rather
 * than with the conversation. Measured at 8,000 indexed vectors and 2,000 session turns: 42.4s
 * before, 27.8ms after. The V62 `idx_session_memory_vec_rowid` index then makes each per-KNN-row
 * probe a point lookup instead of a range scan over `idx_session_memory_session`.
 *
 * The `, sm.vec_rowid ASC` tiebreak is what keeps "results identical" literally true, and it
 * matters MORE here than in `vec-store.ts` because of the `LIMIT ?`: `ORDER BY knn.distance`
 * alone leaves exactly-equal distances in whatever order the join emitted them, the join order is
 * what changed, and a tie group straddling the limit boundary would change WHICH turns are
 * recalled — not merely their order. Ascending `vec_rowid` is the pre-fix order rather than a new
 * one: `append()` allocates `MAX(rowid) + 1` and writes the `session_memory` row in the same
 * transaction, so vec rowid and row id ascend together.
 *
 * Guarded by session-memory-join-order.test.ts: a plan case that fails if `CROSS` is relaxed, and
 * equivalence cases — including a deliberately tie-bearing one — proving the row set and its
 * order are unchanged against the pre-fix query.
 */
export const SESSION_RECALL_SQL = `
      SELECT sm.chunk_text AS chunkText, sm.role AS role, sm.created_at AS createdAt, knn.distance AS distance
      FROM (
        SELECT rowid, distance FROM vec_items_384 WHERE embedding MATCH ? AND k = ?
      ) knn
      CROSS JOIN session_memory sm ON sm.vec_rowid = knn.rowid
      WHERE sm.session_id = ?
      ORDER BY knn.distance, sm.vec_rowid ASC
      LIMIT ?
`;

export class SessionMemoryStore {
  private readonly db: Database;
  private readonly dims: number;
  private readonly embedText: (text: string) => Promise<Float32Array | null>;

  constructor(deps: SessionMemoryStoreDeps) {
    this.db = deps.db;
    this.dims = deps.dims;
    this.embedText = deps.embedText;
  }

  private ensureReady(): boolean {
    const uv = readIndexedUserVersion(this.db);
    if (uv < 10) {
      return false;
    }
    return ensureSqliteVecForConnection(this.db, uv);
  }

  async append(chunk: SessionChunk): Promise<void> {
    if (!this.ensureReady()) {
      return;
    }
    const vec = await this.embedText(chunk.text);
    const hasVec = vec !== null && vec.length === this.dims;
    const now = chunk.createdAt;
    if (!hasVec) {
      dbRun(
        this.db,
        `INSERT INTO session_memory (session_id, chunk_text, vec_rowid, role, created_at)
         VALUES (?, ?, 0, ?, ?)`,
        [chunk.sessionId, chunk.text, chunk.role, now],
      );
      return;
    }
    this.db.transaction(() => {
      const maxRow = this.db
        .query(`SELECT COALESCE(MAX(rowid), 0) AS m FROM vec_items_384`)
        .get() as { m: number | bigint };
      const rowid = Number(maxRow.m) + 1;
      dbRun(this.db, `INSERT INTO vec_items_384(rowid, embedding) VALUES (?, vec_f32(?))`, [
        BigInt(rowid),
        new Float32Array(vec),
      ]);
      dbRun(
        this.db,
        `INSERT INTO session_memory (session_id, chunk_text, vec_rowid, role, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [chunk.sessionId, chunk.text, rowid, chunk.role, now],
      );
    })();
  }

  async recall(sessionId: string, query: string, topK = 8): Promise<SessionMemoryRecallHit[]> {
    if (!this.ensureReady()) {
      return [];
    }
    const qVec = await this.embedText(query);
    if (qVec?.length !== this.dims) {
      return [];
    }
    const k = Math.min(32, Math.max(1, Math.floor(topK)));
    const lim = Math.min(200, k * 4);
    const q = new Float32Array(qVec);
    const rows = this.db.query(SESSION_RECALL_SQL).all(q, lim, sessionId, k) as Array<{
      chunkText: string;
      role: string;
      createdAt: number;
      distance: number;
    }>;
    const out: SessionMemoryRecallHit[] = [];
    for (const r of rows) {
      const role = r.role;
      if (role !== "user" && role !== "assistant" && role !== "tool") {
        continue;
      }
      out.push({
        chunkText: r.chunkText,
        role,
        createdAt: r.createdAt,
        distance: r.distance,
      });
    }
    return out;
  }

  async getRecentTurns(
    sessionId: string,
    limit: number,
  ): Promise<Array<{ text: string; role: SessionMemoryRole; createdAt: number }>> {
    // This read touches only the `session_memory` table — never a vec virtual table — so it must
    // NOT gate on ensureReady() (which also requires the sqlite-vec extension to load). On a runner
    // where sqlite-vec is unavailable (no npm prebuilt + no sidecar), the table still holds the
    // no-vec rows append() wrote; gating on vec readiness here silently dropped them (empty turns),
    // which is why the I27 share e2e redaction round-trip failed on all 3 OS legs. Gate on table
    // existence (V10) only, mirroring listSessions()/deleteSession().
    if (readIndexedUserVersion(this.db) < 10) {
      return [];
    }
    const k = Math.min(200, Math.max(1, Math.floor(limit)));
    const rows = this.db
      .query(
        `SELECT chunk_text AS text, role, created_at AS createdAt
         FROM session_memory
         WHERE session_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(sessionId, k) as Array<{ text: string; role: string; createdAt: number }>;
    const out: Array<{ text: string; role: SessionMemoryRole; createdAt: number }> = [];
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (r === undefined) continue;
      const role = r.role;
      if (role !== "user" && role !== "assistant" && role !== "tool") continue;
      out.push({ text: r.text, role, createdAt: r.createdAt });
    }
    return out;
  }

  pruneExpired(ttlMs: number, nowMs: number): number {
    if (!this.ensureReady()) {
      return 0;
    }
    const cutoff = nowMs - ttlMs;
    const rows = this.db
      .query(`SELECT id FROM session_memory WHERE created_at < ?`)
      .all(cutoff) as { id: number }[];
    for (const r of rows) {
      dbRun(this.db, `DELETE FROM session_memory WHERE id = ?`, [r.id]);
    }
    return rows.length;
  }

  deleteSession(sessionId: string): void {
    if (readIndexedUserVersion(this.db) < 10) {
      return;
    }
    dbRun(this.db, `DELETE FROM session_memory WHERE session_id = ?`, [sessionId]);
  }

  listSessions(): Array<{ sessionId: string; lastWriteAt: number; chunkCount: number }> {
    if (readIndexedUserVersion(this.db) < 10) {
      return [];
    }
    return this.db
      .query(
        `SELECT session_id AS sessionId,
                MAX(created_at) AS lastWriteAt,
                COUNT(*) AS chunkCount
         FROM session_memory
         GROUP BY session_id
         ORDER BY lastWriteAt DESC
         LIMIT 500`,
      )
      .all() as Array<{ sessionId: string; lastWriteAt: number; chunkCount: number }>;
  }
}
