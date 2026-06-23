import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { LocalIndex } from "../index/local-index.ts";
import { isVecLoaded, tryLoadSqliteVec } from "../index/sqlite-vec-load.ts";
import { SessionMemoryStore } from "./session-memory-store.ts";

function vecAvailable(): boolean {
  const db = new Database(":memory:");
  tryLoadSqliteVec(db);
  const ok = isVecLoaded(db);
  db.close();
  return ok;
}
const VEC_AVAILABLE = vecAvailable();

/** Minimal schema with session_memory table and user_version set to 5 (< 10).
 *  This exercises the ensureReady() → uv < 10 → return false path.
 */
function createUnreadyDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_memory (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    TEXT NOT NULL,
      chunk_text    TEXT NOT NULL,
      vec_rowid     INTEGER NOT NULL DEFAULT 0,
      role          TEXT NOT NULL,
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_session_memory_session ON session_memory(session_id);
    CREATE INDEX IF NOT EXISTS idx_session_memory_created ON session_memory(created_at);
    PRAGMA user_version = 5;
  `);
  return db;
}

describe.skipIf(!VEC_AVAILABLE)("SessionMemoryStore", () => {
  test("append and recall scoped to session_id", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);

    const fixed = new Float32Array(384).fill(0.03);
    const store = new SessionMemoryStore({
      db,
      dims: 384,
      embedText: async (t: string) => {
        if (t.includes("payment")) {
          const v = new Float32Array(384).fill(0.9);
          return v;
        }
        return new Float32Array(fixed);
      },
    });

    const sid = "sess-a";
    await store.append({
      sessionId: sid,
      text: "We discussed payment-service rollout",
      role: "user",
      createdAt: Date.now(),
    });
    await store.append({
      sessionId: "sess-b",
      text: "Unrelated topic about cats",
      role: "user",
      createdAt: Date.now(),
    });

    const hits = await store.recall(sid, "payment rollout", 4);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]?.chunkText).toContain("payment-service");

    const other = await store.recall("sess-b", "payment rollout", 4);
    expect(other.some((h) => h.chunkText.includes("payment-service"))).toBe(false);

    store.deleteSession(sid);
    const after = await store.recall(sid, "payment", 4);
    expect(after).toHaveLength(0);
  });

  test("BUG-005: getRecentTurns returns chronological turns scoped to sessionId", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const store = new SessionMemoryStore({
      db,
      dims: 384,
      embedText: async () => new Float32Array(384).fill(0.04),
    });
    const sid = "sess-recent";

    await store.append({ sessionId: sid, text: "first user turn", role: "user", createdAt: 100 });
    await store.append({
      sessionId: sid,
      text: "first assistant reply",
      role: "assistant",
      createdAt: 200,
    });
    await store.append({ sessionId: sid, text: "second user turn", role: "user", createdAt: 300 });
    await store.append({
      sessionId: "sess-other",
      text: "unrelated user turn",
      role: "user",
      createdAt: 250,
    });

    const recent = await store.getRecentTurns(sid, 10);
    expect(recent.map((t) => t.text)).toEqual([
      "first user turn",
      "first assistant reply",
      "second user turn",
    ]);
    expect(recent.map((t) => t.role)).toEqual(["user", "assistant", "user"]);
    expect(recent.map((t) => t.createdAt)).toEqual([100, 200, 300]);
  });

  test("BUG-005 follow-up: append still records the literal turn when embedText returns null", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const store = new SessionMemoryStore({
      db,
      dims: 384,
      embedText: async () => null,
    });
    const sid = "sess-no-embedding";

    await store.append({ sessionId: sid, text: "user turn one", role: "user", createdAt: 100 });
    await store.append({
      sessionId: sid,
      text: "assistant reply one",
      role: "assistant",
      createdAt: 200,
    });

    const recent = await store.getRecentTurns(sid, 10);
    expect(recent).toHaveLength(2);
    expect(recent.map((t) => t.text)).toEqual(["user turn one", "assistant reply one"]);
    expect(recent.map((t) => t.role)).toEqual(["user", "assistant"]);
  });

  test("BUG-005: getRecentTurns honors the limit and returns the most recent N (oldest-first)", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const store = new SessionMemoryStore({
      db,
      dims: 384,
      embedText: async () => new Float32Array(384).fill(0.04),
    });
    const sid = "sess-trim";
    for (let i = 0; i < 6; i++) {
      await store.append({
        sessionId: sid,
        text: `turn ${String(i)}`,
        role: i % 2 === 0 ? "user" : "assistant",
        createdAt: 1000 + i,
      });
    }
    const recent = await store.getRecentTurns(sid, 3);
    expect(recent.map((t) => t.text)).toEqual(["turn 3", "turn 4", "turn 5"]);
  });

  // append with wrong-dimension vec (hasVec = false because vec.length !== dims)
  test("append falls back to no-vec path when embedText returns wrong-dimension vector", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const store = new SessionMemoryStore({
      db,
      dims: 384,
      // Return a 4-element array — wrong size, triggers hasVec=false branch
      embedText: async () => new Float32Array(4).fill(0.1),
    });
    const sid = "sess-wrong-dim";
    await store.append({ sessionId: sid, text: "wrong dim text", role: "user", createdAt: 50 });

    // Row inserted with vec_rowid = 0 (no-vec path)
    const recent = await store.getRecentTurns(sid, 10);
    expect(recent).toHaveLength(1);
    expect(recent[0]?.text).toBe("wrong dim text");
  });

  // recall returns [] when qVec is null
  test("recall returns empty array when embedText returns null for the query", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    // First store a chunk with real embedding
    const storeIngest = new SessionMemoryStore({
      db,
      dims: 384,
      embedText: async () => new Float32Array(384).fill(0.5),
    });
    await storeIngest.append({
      sessionId: "sess-recall-null",
      text: "some important text",
      role: "user",
      createdAt: 100,
    });

    // Now recall with a store whose embedText returns null
    const storeQuery = new SessionMemoryStore({
      db,
      dims: 384,
      embedText: async () => null,
    });
    const hits = await storeQuery.recall("sess-recall-null", "important", 4);
    expect(hits).toHaveLength(0);
  });

  // recall returns [] when qVec has wrong length
  test("recall returns empty array when embedText returns wrong-dimension vector for query", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const store = new SessionMemoryStore({
      db,
      dims: 384,
      embedText: async (text: string) => {
        if (text === "query text") {
          return new Float32Array(10).fill(0.1);
        }
        return new Float32Array(384).fill(0.5);
      },
    });
    await store.append({
      sessionId: "sess-recall-dim",
      text: "stored text",
      role: "user",
      createdAt: 100,
    });

    const hits = await store.recall("sess-recall-dim", "query text", 4);
    expect(hits).toHaveLength(0);
  });

  // pruneExpired — zero rows pruned
  test("pruneExpired returns 0 when no rows are expired", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const store = new SessionMemoryStore({
      db,
      dims: 384,
      embedText: async () => new Float32Array(384).fill(0.1),
    });

    await store.append({
      sessionId: "sess-prune-none",
      text: "recent text",
      role: "user",
      createdAt: 9_000_000,
    });

    // TTL=1ms, now=5_000_000 → cutoff=4_999_999 < createdAt=9_000_000, no rows expired
    const pruned = store.pruneExpired(1, 5_000_000);
    expect(pruned).toBe(0);
  });

  // pruneExpired — rows are pruned
  test("pruneExpired removes expired rows and returns the count", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const store = new SessionMemoryStore({
      db,
      dims: 384,
      embedText: async () => null, // no-vec path
    });

    await store.append({
      sessionId: "sess-prune",
      text: "old chunk 1",
      role: "user",
      createdAt: 100,
    });
    await store.append({
      sessionId: "sess-prune",
      text: "old chunk 2",
      role: "assistant",
      createdAt: 200,
    });
    await store.append({
      sessionId: "sess-prune",
      text: "new chunk",
      role: "user",
      createdAt: 9_000_000,
    });

    // TTL=100ms, now=1000 → cutoff=900 → rows at 100 and 200 are expired
    const pruned = store.pruneExpired(100, 1_000);
    expect(pruned).toBe(2);

    // Only the new chunk remains
    const recent = await store.getRecentTurns("sess-prune", 10);
    expect(recent).toHaveLength(1);
    expect(recent[0]?.text).toBe("new chunk");
  });

  // listSessions — returns session rows
  test("listSessions returns sessions sorted by lastWriteAt DESC", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const store = new SessionMemoryStore({
      db,
      dims: 384,
      embedText: async () => null,
    });

    await store.append({ sessionId: "ls-sess-a", text: "a1", role: "user", createdAt: 1000 });
    await store.append({
      sessionId: "ls-sess-a",
      text: "a2",
      role: "assistant",
      createdAt: 2000,
    });
    await store.append({ sessionId: "ls-sess-b", text: "b1", role: "user", createdAt: 3000 });

    const sessions = store.listSessions();
    expect(sessions).toHaveLength(2);
    // Most-recent session first
    expect(sessions[0]?.sessionId).toBe("ls-sess-b");
    expect(sessions[0]?.lastWriteAt).toBe(3000);
    expect(sessions[0]?.chunkCount).toBe(1);
    expect(sessions[1]?.sessionId).toBe("ls-sess-a");
    expect(sessions[1]?.lastWriteAt).toBe(2000);
    expect(sessions[1]?.chunkCount).toBe(2);
  });

  // listSessions — empty result
  test("listSessions returns empty array when no sessions exist", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const store = new SessionMemoryStore({ db, dims: 384, embedText: async () => null });
    const sessions = store.listSessions();
    expect(sessions).toEqual([]);
  });

  // topK clamping in recall (topK < 1 → clamped to 1)
  test("recall clamps topK < 1 to 1 without throwing", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const store = new SessionMemoryStore({
      db,
      dims: 384,
      embedText: async () => new Float32Array(384).fill(0.5),
    });
    await store.append({
      sessionId: "sess-clamp",
      text: "clamped text",
      role: "user",
      createdAt: 100,
    });
    // topK=0 should be clamped to 1, must not throw
    const hits = await store.recall("sess-clamp", "clamped text", 0);
    expect(Array.isArray(hits)).toBe(true);
  });

  // getRecentTurns clamps limit < 1 to 1
  test("getRecentTurns clamps limit < 1 to 1", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const store = new SessionMemoryStore({
      db,
      dims: 384,
      embedText: async () => null,
    });
    await store.append({
      sessionId: "sess-limit-clamp",
      text: "text a",
      role: "user",
      createdAt: 100,
    });
    await store.append({
      sessionId: "sess-limit-clamp",
      text: "text b",
      role: "user",
      createdAt: 200,
    });
    // limit=0 clamped to 1 → returns at most 1 (the most recent)
    const recent = await store.getRecentTurns("sess-limit-clamp", 0);
    expect(recent).toHaveLength(1);
    expect(recent[0]?.text).toBe("text b");
  });

  // getRecentTurns filters out rows with invalid role values
  test("getRecentTurns skips rows with invalid role values", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const store = new SessionMemoryStore({
      db,
      dims: 384,
      embedText: async () => null,
    });
    // Insert a valid row via the store
    await store.append({
      sessionId: "sess-role-filter",
      text: "valid user text",
      role: "user",
      createdAt: 100,
    });
    // Directly insert a row with an invalid role to exercise the `continue` branch
    db.exec(
      `INSERT INTO session_memory (session_id, chunk_text, vec_rowid, role, created_at)
       VALUES ('sess-role-filter', 'invalid role text', 0, 'system', 200)`,
    );
    const turns = await store.getRecentTurns("sess-role-filter", 10);
    // The "system" role row is filtered out; only the valid row is returned
    expect(turns).toHaveLength(1);
    expect(turns[0]?.text).toBe("valid user text");
    expect(turns[0]?.role).toBe("user");
  });

  // tool role is accepted in getRecentTurns
  test("getRecentTurns accepts tool role", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const store = new SessionMemoryStore({
      db,
      dims: 384,
      embedText: async () => null,
    });
    await store.append({
      sessionId: "sess-tool-role",
      text: "tool output text",
      role: "tool",
      createdAt: 100,
    });
    const turns = await store.getRecentTurns("sess-tool-role", 10);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.role).toBe("tool");
    expect(turns[0]?.text).toBe("tool output text");
  });
});

// ---------------------------------------------------------------
// Tests that run regardless of VEC_AVAILABLE:
// exercise all the "schema not ready" early-return paths
// ---------------------------------------------------------------
describe("SessionMemoryStore — schema not ready (uv < 10)", () => {
  let db: Database;

  beforeEach(() => {
    db = createUnreadyDb();
  });

  afterEach(() => {
    db.close();
  });

  test("append returns immediately when schema version < 10", async () => {
    const store = new SessionMemoryStore({
      db,
      dims: 384,
      embedText: async () => new Float32Array(384).fill(0.5),
    });
    // Should not throw; no rows inserted
    await store.append({ sessionId: "s1", text: "hello", role: "user", createdAt: 1 });
    const count = (db.query("SELECT COUNT(*) AS n FROM session_memory").get() as { n: number }).n;
    expect(count).toBe(0);
  });

  test("recall returns [] when schema version < 10", async () => {
    const store = new SessionMemoryStore({
      db,
      dims: 384,
      embedText: async () => new Float32Array(384).fill(0.5),
    });
    const result = await store.recall("s1", "query", 4);
    expect(result).toEqual([]);
  });

  test("getRecentTurns returns [] when schema version < 10", async () => {
    const store = new SessionMemoryStore({
      db,
      dims: 384,
      embedText: async () => new Float32Array(384).fill(0.5),
    });
    const result = await store.getRecentTurns("s1", 10);
    expect(result).toEqual([]);
  });

  test("pruneExpired returns 0 when schema version < 10", () => {
    const store = new SessionMemoryStore({
      db,
      dims: 384,
      embedText: async () => null,
    });
    const pruned = store.pruneExpired(1000, Date.now());
    expect(pruned).toBe(0);
  });

  test("deleteSession returns immediately when schema version < 10", () => {
    const store = new SessionMemoryStore({
      db,
      dims: 384,
      embedText: async () => null,
    });
    // Insert a row directly to verify it is NOT deleted
    db.exec(
      `INSERT INTO session_memory (session_id, chunk_text, vec_rowid, role, created_at)
       VALUES ('s1', 'direct-insert', 0, 'user', 1)`,
    );
    store.deleteSession("s1");
    const count = (db.query("SELECT COUNT(*) AS n FROM session_memory").get() as { n: number }).n;
    expect(count).toBe(1);
  });

  test("listSessions returns [] when schema version < 10", () => {
    const store = new SessionMemoryStore({
      db,
      dims: 384,
      embedText: async () => null,
    });
    const sessions = store.listSessions();
    expect(sessions).toEqual([]);
  });
});
