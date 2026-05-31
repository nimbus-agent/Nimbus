import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

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
    expect(after.length).toBe(0);
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
    expect(recent.length).toBe(2);
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
});
