// packages/gateway/src/index/migrations/runner-v42.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { LocalIndex } from "../local-index.ts";

describe("V42 — tool_call_log.params_json", () => {
  test("adds nullable params_json column to tool_call_log", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const cols = (db.query("PRAGMA table_info(tool_call_log)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain("params_json");
  });

  test("old rows without params read back as NULL", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    db.run(
      `INSERT INTO tool_call_log (session_id, tool_id, service, called_at, duration_ms, result_envelope, status)
       VALUES ('s1', 'gmail_search', 'gmail', 1, 5, '{}', 'ok')`,
    );
    const row = db
      .query("SELECT params_json FROM tool_call_log WHERE tool_id = 'gmail_search'")
      .get() as {
      params_json: string | null;
    };
    expect(row.params_json).toBeNull();
  });
});
