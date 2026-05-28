import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { createGetSessionTranscriptHandler } from "./engine-get-session-transcript.ts";

function seedDb(): Database {
  const db = new Database(":memory:");
  db.run(`
    CREATE TABLE audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      action_type TEXT NOT NULL,
      hitl_status TEXT NOT NULL,
      action_json TEXT NOT NULL,
      timestamp   INTEGER NOT NULL,
      row_hash    TEXT,
      prev_hash   TEXT,
      session_id  TEXT
    )
  `);
  const insert = db.prepare(
    "INSERT INTO audit_log (action_type, hitl_status, action_json, timestamp, session_id) VALUES (?, ?, ?, ?, ?)",
  );
  insert.run("engine.askUser", "not_required", JSON.stringify({ text: "hello" }), 1000, "sess-1");
  insert.run(
    "engine.askAssistant",
    "not_required",
    JSON.stringify({ text: "hi there" }),
    1100,
    "sess-1",
  );
  insert.run(
    "engine.askUser",
    "not_required",
    JSON.stringify({ text: "how are you" }),
    2000,
    "sess-1",
  );
  insert.run(
    "engine.askAssistant",
    "not_required",
    JSON.stringify({ text: "fine" }),
    2100,
    "sess-1",
  );
  insert.run(
    "engine.askUser",
    "not_required",
    JSON.stringify({ text: "noise" }),
    3000,
    "sess-OTHER",
  );
  return db;
}

describe("createGetSessionTranscriptHandler", () => {
  test("returns ordered turns for the requested session", async () => {
    const db = seedDb();
    const handler = createGetSessionTranscriptHandler(db);
    const result = await handler({ sessionId: "sess-1" });
    expect(result.sessionId).toBe("sess-1");
    expect(result.turns.length).toBe(4);
    expect(result.turns[0]).toMatchObject({ role: "user", text: "hello", timestamp: 1000 });
    expect(result.turns[1]).toMatchObject({ role: "assistant", text: "hi there" });
    expect(result.hasMore).toBe(false);
  });

  test("clamps limit to [1, 500] and reports hasMore", async () => {
    const db = seedDb();
    const handler = createGetSessionTranscriptHandler(db);
    const r1 = await handler({ sessionId: "sess-1", limit: 2 });
    expect(r1.turns.length).toBe(2);
    expect(r1.hasMore).toBe(true);
    const r2 = await handler({ sessionId: "sess-1", limit: 9999 });
    expect(r2.turns.length).toBe(4);
    expect(r2.hasMore).toBe(false);
    const r3 = await handler({ sessionId: "sess-1", limit: 0 });
    expect(r3.turns.length).toBeGreaterThanOrEqual(1);
  });

  test("returns empty turns for unknown sessionId", async () => {
    const db = seedDb();
    const handler = createGetSessionTranscriptHandler(db);
    const result = await handler({ sessionId: "never" });
    expect(result.sessionId).toBe("never");
    expect(result.turns).toEqual([]);
    expect(result.hasMore).toBe(false);
  });

  test("rejects invalid params", async () => {
    const db = seedDb();
    const handler = createGetSessionTranscriptHandler(db);
    await expect(handler({ sessionId: "" })).rejects.toThrow();
    await expect(handler({} as { sessionId: string })).rejects.toThrow();
  });
});
