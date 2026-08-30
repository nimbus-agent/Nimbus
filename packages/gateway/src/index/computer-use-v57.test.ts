import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { COMPUTER_USE_V57_SQL } from "./computer-use-v57-sql.ts";

function db(): Database {
  const d = new Database(":memory:");
  d.exec(COMPUTER_USE_V57_SQL);
  return d;
}

describe("V57 — computer-use session + action stream", () => {
  test("creates both tables", () => {
    const d = db();
    const names = d
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'cu_%' ORDER BY name`,
      )
      .all()
      .map((r) => r.name);
    expect(names).toEqual(["cu_action", "cu_session"]);
    d.close();
  });

  test("rejects a lane outside the CHECK", () => {
    const d = db();
    expect(() =>
      d.run(
        `INSERT INTO cu_session (id, lane, envelope_json, opened_at, actions_used)
         VALUES ('s1', 'telepathy', '{}', 1, 0)`,
      ),
    ).toThrow();
    d.close();
  });

  test("rejects a classification outside the CHECK", () => {
    const d = db();
    d.run(
      `INSERT INTO cu_session (id, lane, envelope_json, opened_at, actions_used)
       VALUES ('s1', 'browser', '{}', 1, 0)`,
    );
    expect(() =>
      d.run(
        `INSERT INTO cu_action (id, session_id, seq, kind, classification, observed_target, hitl_status, outcome, timestamp)
         VALUES ('a1', 's1', 1, 'click', 'probably-fine', 'button', 'approved', 'actuated', 1)`,
      ),
    ).toThrow();
    d.close();
  });

  test("enforces one action per (session, seq)", () => {
    const d = db();
    d.run(
      `INSERT INTO cu_session (id, lane, envelope_json, opened_at, actions_used)
       VALUES ('s1', 'browser', '{}', 1, 0)`,
    );
    const ins = (id: string) =>
      d.run(
        `INSERT INTO cu_action (id, session_id, seq, kind, classification, observed_target, hitl_status, outcome, timestamp)
         VALUES ('${id}', 's1', 1, 'click', 'actuating', 'button', 'approved', 'actuated', 1)`,
      );
    ins("a1");
    expect(() => ins("a2")).toThrow();
    d.close();
  });

  test("an action cascades away with its session", () => {
    const d = db();
    d.run(`PRAGMA foreign_keys = ON`);
    d.run(
      `INSERT INTO cu_session (id, lane, envelope_json, opened_at, actions_used)
       VALUES ('s1', 'browser', '{}', 1, 0)`,
    );
    d.run(
      `INSERT INTO cu_action (id, session_id, seq, kind, classification, observed_target, hitl_status, outcome, timestamp)
       VALUES ('a1', 's1', 1, 'click', 'actuating', 'button', 'approved', 'actuated', 1)`,
    );
    d.run(`DELETE FROM cu_session WHERE id = 's1'`);
    expect(d.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM cu_action`).get()?.n).toBe(0);
    d.close();
  });
});
