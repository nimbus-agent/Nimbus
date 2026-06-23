import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";
import { listWatcherHistory } from "./watcher-history";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  db.run(
    `INSERT INTO watcher (id, name, enabled, condition_type, condition_json, action_type, action_json, created_at)
     VALUES ('w1', 'alpha', 1, 'schedule', '{}', 'notify', '{}', 0)`,
  );
});

afterEach(() => db.close());

test("listWatcherHistory returns the last N fires newest-first", () => {
  for (let i = 0; i < 5; i++) {
    db.run(
      `INSERT INTO watcher_event (watcher_id, fired_at, condition_snapshot, action_result)
       VALUES ('w1', ?, ?, ?)`,
      [100 + i, `{"i":${i}}`, `{"ok":true}`],
    );
  }
  const out = listWatcherHistory(db, { watcherId: "w1", limit: 3 });
  expect(out.events).toHaveLength(3);
  expect(out.events[0]?.firedAt).toBe(104);
  expect(out.events[2]?.firedAt).toBe(102);
  expect(out.events[0]?.conditionSnapshot).toBe('{"i":4}');
});

test("listWatcherHistory returns empty for an unknown watcher", () => {
  const out = listWatcherHistory(db, { watcherId: "nonexistent", limit: 10 });
  expect(out.events).toEqual([]);
});

test("listWatcherHistory returns empty on a pre-v8 schema", () => {
  const fresh = new Database(":memory:");
  try {
    const out = listWatcherHistory(fresh, { watcherId: "w1", limit: 10 });
    expect(out.events).toEqual([]);
  } finally {
    fresh.close();
  }
});

test("listWatcherHistory clamps limit to 1..500", () => {
  const out0 = listWatcherHistory(db, { watcherId: "w1", limit: 0 });
  expect(out0.events).toEqual([]);
  for (let i = 0; i < 501; i++) {
    db.run(
      `INSERT INTO watcher_event (watcher_id, fired_at, condition_snapshot, action_result)
       VALUES ('w1', ?, '{}', '{}')`,
      [i],
    );
  }
  const outBig = listWatcherHistory(db, { watcherId: "w1", limit: 10000 });
  expect(outBig.events).toHaveLength(500);
});
