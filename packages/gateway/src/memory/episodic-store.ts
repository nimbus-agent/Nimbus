import type { Database } from "bun:sqlite";

import { dbRun } from "../db/write.ts";

/**
 * Storage of long-term episodic memory (Phase 10, owner ruling OR-S4-MEM, invariant I61). The ONLY module that
 * reads or writes `episodic_pending_turn` and `episodic_memory` (static D52 confines both table names to this
 * file, the V107 DDL and the migration runner).
 *
 * What goes in is typed so a caller cannot widen it: `PendingTurn` carries the OWNER's message and the final
 * assistant answer and nothing else. There is no field, and so no argument, for a tool result, a connector
 * item or text an MCP client sent.
 */

export const PENDING_TEXT_MAX = 4_000;
export const PENDING_TURNS_PER_SESSION_MAX = 40;
export const SUMMARY_MAX = 1_200;
/** Most recent memories the recall scan reads. A memory is at most `SUMMARY_MAX` characters. */
export const RECALL_SCAN_MAX = 2_000;

export type PendingTurn = { readonly ownerText: string; readonly answerText: string };

export type StoredMemory = {
  readonly id: string;
  readonly sessionId: string;
  readonly summary: string;
  readonly turnCount: number;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly createdAt: number;
  readonly embedded: boolean;
};

export type RecalledRow = StoredMemory & { readonly similarity: number };

type MemoryRow = {
  id: string;
  session_id: string;
  summary: string;
  turn_count: number;
  started_at: number;
  ended_at: number;
  created_at: number;
  embedded: number;
};

function toMemory(r: MemoryRow): StoredMemory {
  return {
    id: r.id,
    sessionId: r.session_id,
    summary: r.summary,
    turnCount: r.turn_count,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    createdAt: r.created_at,
    embedded: r.embedded === 1,
  };
}

function newMemoryId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return `mem_${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}

function encodeVector(v: Float32Array): Uint8Array {
  return new Uint8Array(new Float32Array(v).buffer);
}

function decodeVector(blob: Uint8Array, dims: number): Float32Array | undefined {
  if (blob.byteLength !== dims * 4) return undefined;
  const copy = new Uint8Array(blob);
  return new Float32Array(copy.buffer);
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

const MEMORY_COLUMNS = `id, session_id, summary, turn_count, started_at, ended_at, created_at,
  (embedding IS NOT NULL) AS embedded`;

export class EpisodicStore {
  constructor(private readonly db: Database) {}

  /** Keeps the newest `PENDING_TURNS_PER_SESSION_MAX` turns of a session, so a long session stays bounded. */
  recordTurn(sessionId: string, turn: PendingTurn, createdAt: number): void {
    this.db.transaction(() => {
      dbRun(
        this.db,
        `INSERT INTO episodic_pending_turn (session_id, owner_text, answer_text, created_at)
         VALUES (?, ?, ?, ?)`,
        [
          sessionId,
          turn.ownerText.slice(0, PENDING_TEXT_MAX),
          turn.answerText.slice(0, PENDING_TEXT_MAX),
          createdAt,
        ],
      );
      dbRun(
        this.db,
        `DELETE FROM episodic_pending_turn WHERE session_id = ? AND id NOT IN (
           SELECT id FROM episodic_pending_turn WHERE session_id = ? ORDER BY id DESC LIMIT ?)`,
        [sessionId, sessionId, PENDING_TURNS_PER_SESSION_MAX],
      );
    })();
  }

  /** Sessions whose newest pending turn is older than `cutoffMs`, oldest first. */
  idleSessions(cutoffMs: number, limit: number): string[] {
    const rows = this.db
      .query(
        `SELECT session_id AS sessionId FROM episodic_pending_turn
         GROUP BY session_id HAVING MAX(created_at) < ? ORDER BY MAX(created_at) ASC LIMIT ?`,
      )
      .all(cutoffMs, limit) as Array<{ sessionId: string }>;
    return rows.map((r) => r.sessionId);
  }

  pendingTurns(
    sessionId: string,
  ): Array<PendingTurn & { readonly id: number; readonly createdAt: number }> {
    return this.db
      .query(
        `SELECT id, owner_text AS ownerText, answer_text AS answerText, created_at AS createdAt
         FROM episodic_pending_turn WHERE session_id = ? ORDER BY id ASC`,
      )
      .all(sessionId) as Array<PendingTurn & { id: number; createdAt: number }>;
  }

  /** Drops exactly these pending rows; a turn that arrived meanwhile stays for the next pass. */
  dropPending(ids: readonly number[]): void {
    for (const id of ids) dbRun(this.db, "DELETE FROM episodic_pending_turn WHERE id = ?", [id]);
  }

  /** Drops every pending turn (the owner turned memory off). */
  dropAllPending(): void {
    dbRun(this.db, "DELETE FROM episodic_pending_turn");
  }

  pendingCount(): number {
    const r = this.db.query("SELECT COUNT(*) AS n FROM episodic_pending_turn").get() as {
      n: number;
    };
    return r.n;
  }

  /** Stores one summary and drops the session's pending turns, in one transaction. */
  finishSession(input: {
    readonly sessionId: string;
    /** The pending rows that were summarised; only these are deleted. */
    readonly turnIds: readonly number[];
    readonly summary: string;
    readonly turnCount: number;
    readonly startedAt: number;
    readonly endedAt: number;
    readonly now: number;
    readonly embedding: Float32Array | null;
  }): string {
    const id = newMemoryId();
    this.db.transaction(() => {
      dbRun(
        this.db,
        `INSERT INTO episodic_memory
           (id, session_id, summary, turn_count, started_at, ended_at, created_at, embedding)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.sessionId,
          input.summary.slice(0, SUMMARY_MAX),
          input.turnCount,
          input.startedAt,
          input.endedAt,
          input.now,
          input.embedding === null ? null : encodeVector(input.embedding),
        ],
      );
      for (const id of input.turnIds) {
        dbRun(this.db, "DELETE FROM episodic_pending_turn WHERE id = ?", [id]);
      }
    })();
    return id;
  }

  /** Newest first. */
  list(limit: number): StoredMemory[] {
    const rows = this.db
      .query(
        `SELECT ${MEMORY_COLUMNS} FROM episodic_memory ORDER BY created_at DESC, id ASC LIMIT ?`,
      )
      .all(limit) as MemoryRow[];
    return rows.map(toMemory);
  }

  count(): number {
    const r = this.db.query("SELECT COUNT(*) AS n FROM episodic_memory").get() as { n: number };
    return r.n;
  }

  /** The best `topK` memories at or above `minSimilarity` to `query` (cosine), best first. */
  recall(query: Float32Array, topK: number, minSimilarity: number): RecalledRow[] {
    const rows = this.db
      .query(
        `SELECT ${MEMORY_COLUMNS}, embedding AS blob FROM episodic_memory
         WHERE embedding IS NOT NULL ORDER BY created_at DESC, id ASC LIMIT ?`,
      )
      .all(RECALL_SCAN_MAX) as Array<MemoryRow & { blob: Uint8Array }>;
    const scored: RecalledRow[] = [];
    for (const r of rows) {
      const v = decodeVector(r.blob, query.length);
      if (v === undefined) continue;
      const similarity = cosine(query, v);
      if (similarity >= minSimilarity) scored.push({ ...toMemory(r), similarity });
    }
    scored.sort((a, b) => b.similarity - a.similarity || b.createdAt - a.createdAt);
    return scored.slice(0, topK);
  }

  forget(id: string): boolean {
    return dbRun(this.db, "DELETE FROM episodic_memory WHERE id = ?", [id]).changes > 0;
  }

  /** Every memory and every pending turn. Returns the number of memories removed. */
  forgetAll(): number {
    return this.db.transaction(() => {
      const n = dbRun(this.db, "DELETE FROM episodic_memory").changes;
      dbRun(this.db, "DELETE FROM episodic_pending_turn");
      return n;
    })();
  }

  /** Removes memories and pending turns older than `cutoffMs`. Returns the memories removed. */
  pruneOlderThan(cutoffMs: number): number {
    return this.db.transaction(() => {
      const n = dbRun(this.db, "DELETE FROM episodic_memory WHERE created_at < ?", [
        cutoffMs,
      ]).changes;
      dbRun(this.db, "DELETE FROM episodic_pending_turn WHERE created_at < ?", [cutoffMs]);
      return n;
    })();
  }
}
