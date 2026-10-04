/**
 * `SessionMemoryStore.recall` arms `session-memory-store.test.ts` does not reach: the DEFAULT
 * `topK` (8), and a stored turn whose role is outside the typed set — `recall` must drop it rather
 * than hand an unknown role to the prompt builder.
 *
 * Real SQLite + sqlite-vec, as in the main suite; skipped (with the same probe) on a host where
 * the extension cannot load.
 */
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

/** `turn-<n>` embeds to a constant vector of n/100, so distance from `turn-0` grows with n. */
function embedByTurnNumber(text: string): Promise<Float32Array> {
  const n = Number.parseInt(text.split("-")[1] ?? "0", 10);
  return Promise.resolve(new Float32Array(384).fill(n / 100));
}

function storeOn(db: Database): SessionMemoryStore {
  return new SessionMemoryStore({ db, dims: 384, embedText: embedByTurnNumber });
}

describe.skipIf(!VEC_AVAILABLE)("SessionMemoryStore.recall — coverage edges", () => {
  test("with no topK it returns the 8 nearest turns of THIS session, nearest first", async () => {
    const db = new Database(":memory:");
    try {
      LocalIndex.ensureSchema(db);
      const store = storeOn(db);
      for (let n = 1; n <= 10; n++) {
        await store.append({ sessionId: "s", text: `turn-${n}`, role: "user", createdAt: n });
      }
      // A nearer turn in ANOTHER session must not displace any of this session's eight.
      await store.append({ sessionId: "other", text: "turn-0", role: "user", createdAt: 0 });

      const hits = await store.recall("s", "turn-0");
      expect(hits.map((h) => h.chunkText)).toEqual([
        "turn-1",
        "turn-2",
        "turn-3",
        "turn-4",
        "turn-5",
        "turn-6",
        "turn-7",
        "turn-8",
      ]);
      // Control: an explicit topK still wins over the default.
      expect(await store.recall("s", "turn-0", 3)).toHaveLength(3);
    } finally {
      db.close();
    }
  });

  test("a stored turn with a role outside user/assistant/tool is dropped from recall", async () => {
    const db = new Database(":memory:");
    try {
      LocalIndex.ensureSchema(db);
      const store = storeOn(db);
      await store.append({ sessionId: "s", text: "turn-1", role: "user", createdAt: 1 });
      await store.append({ sessionId: "s", text: "turn-2", role: "assistant", createdAt: 2 });
      await store.append({ sessionId: "s", text: "turn-3", role: "tool", createdAt: 3 });
      // `append` only accepts the typed roles, so a foreign one can only arrive from outside the
      // store (an older build, a hand edit, a future role) — exactly the row recall must not trust.
      db.run(`UPDATE session_memory SET role = 'system' WHERE chunk_text = 'turn-2'`);

      const hits = await store.recall("s", "turn-0", 8);
      expect(hits.map((h) => [h.chunkText, h.role])).toEqual([
        ["turn-1", "user"],
        ["turn-3", "tool"],
      ]);
    } finally {
      db.close();
    }
  });
});
