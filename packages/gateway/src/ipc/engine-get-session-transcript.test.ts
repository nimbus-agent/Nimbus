import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { createGetSessionTranscriptHandler } from "./engine-get-session-transcript.ts";
import { RpcMethodError } from "./server/rpc-error.ts";

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
    expect(result.turns).toHaveLength(4);
    expect(result.turns[0]).toMatchObject({ role: "user", text: "hello", timestamp: 1000 });
    expect(result.turns[1]).toMatchObject({ role: "assistant", text: "hi there" });
    expect(result.hasMore).toBe(false);
  });

  test("clamps limit to [1, 500] and reports hasMore", async () => {
    const db = seedDb();
    const handler = createGetSessionTranscriptHandler(db);
    const r1 = await handler({ sessionId: "sess-1", limit: 2 });
    expect(r1.turns).toHaveLength(2);
    expect(r1.hasMore).toBe(true);
    const r2 = await handler({ sessionId: "sess-1", limit: 9999 });
    expect(r2.turns).toHaveLength(4);
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
    await expect(handler({})).rejects.toThrow();
  });
});

/**
 * A transcript table whose `action_json` is NULLABLE: the reader treats a NULL body as redacted,
 * and only a looser schema than the seeded one above can carry that row.
 */
function nullableBodyDb(
  rows: ReadonlyArray<{ type: string; json: string | null; ts: number; sid?: string }>,
): Database {
  const db = new Database(":memory:");
  db.run(`
    CREATE TABLE audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      action_type TEXT NOT NULL,
      action_json TEXT,
      timestamp   INTEGER NOT NULL,
      session_id  TEXT
    )
  `);
  const insert = db.prepare(
    "INSERT INTO audit_log (action_type, action_json, timestamp, session_id) VALUES (?, ?, ?, ?)",
  );
  for (const r of rows) insert.run(r.type, r.json, r.ts, r.sid ?? "sess-x");
  insert.finalize();
  return db;
}

describe("createGetSessionTranscriptHandler — bodies, roles and params", () => {
  test("a NULL body, a body without a string text, and unparseable JSON all read as [redacted]", async () => {
    const db = nullableBodyDb([
      { type: "engine.askUser", json: null, ts: 1 },
      { type: "engine.askAssistant", json: JSON.stringify({ text: 42 }), ts: 2 },
      { type: "engine.askUser", json: "{not json", ts: 3 },
      { type: "engine.askAssistant", json: JSON.stringify({ text: "kept" }), ts: 4 },
    ]);
    try {
      const result = await createGetSessionTranscriptHandler(db)({ sessionId: "sess-x" });
      expect(result.turns.map((t) => [t.role, t.text])).toEqual([
        ["user", "[redacted]"],
        ["assistant", "[redacted]"],
        ["user", "[redacted]"],
        ["assistant", "kept"],
      ]);
    } finally {
      db.close();
    }
  });

  test("audit rows of other action types in the session are skipped, not mislabelled", async () => {
    const db = nullableBodyDb([
      { type: "engine.askUser", json: JSON.stringify({ text: "question" }), ts: 1 },
      { type: "connector.dispatch", json: JSON.stringify({ text: "not a turn" }), ts: 2 },
      { type: "engine.askAssistant", json: JSON.stringify({ text: "answer" }), ts: 3 },
    ]);
    try {
      const result = await createGetSessionTranscriptHandler(db)({ sessionId: "sess-x" });
      expect(result.turns).toEqual([
        { role: "user", text: "question", timestamp: 1, auditLogId: 1 },
        { role: "assistant", text: "answer", timestamp: 3, auditLogId: 3 },
      ]);
      expect(result.hasMore).toBe(false);
    } finally {
      db.close();
    }
  });

  test("a non-finite limit falls back to the default of 100, not the 500 cap", async () => {
    // More turns than the default and fewer than the cap: only the DEFAULT stops at 100 — clamped
    // to the cap, the same call would return all 102 with hasMore false.
    const db = nullableBodyDb(
      Array.from({ length: 102 }, (_, i) => ({
        type: i % 2 === 0 ? "engine.askUser" : "engine.askAssistant",
        json: JSON.stringify({ text: `t${String(i)}` }),
        ts: i + 1,
      })),
    );
    try {
      const handler = createGetSessionTranscriptHandler(db);
      for (const limit of [Number.POSITIVE_INFINITY, Number.NaN]) {
        const r = await handler({ sessionId: "sess-x", limit });
        expect(r.turns).toHaveLength(100);
        expect(r.turns.at(-1)?.text).toBe("t99");
        expect(r.hasMore).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  test("a fractional limit is truncated, not rounded up", async () => {
    const db = seedDb();
    try {
      const frac = await createGetSessionTranscriptHandler(db)({ sessionId: "sess-1", limit: 2.9 });
      expect(frac.turns.map((t) => t.text)).toEqual(["hello", "hi there"]);
      expect(frac.hasMore).toBe(true);
    } finally {
      db.close();
    }
  });

  test("a missing or non-object params value is refused as -32602 'requires params object'", async () => {
    const db = seedDb();
    try {
      const handler = createGetSessionTranscriptHandler(db);
      for (const bad of [null, undefined, "sess-1", 7]) {
        const err = await handler(bad).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(RpcMethodError);
        expect((err as RpcMethodError).rpcCode).toBe(-32602);
        expect((err as RpcMethodError).message).toBe(
          "engine.getSessionTranscript requires params object",
        );
      }
      // An object without a usable sessionId is the OTHER refusal, not this one.
      const other = await handler({ sessionId: 9 }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect((other as RpcMethodError).message).toBe(
        "engine.getSessionTranscript requires non-empty sessionId",
      );
    } finally {
      db.close();
    }
  });
});
