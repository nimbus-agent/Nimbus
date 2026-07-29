import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { LocalIndex } from "../index/local-index.ts";
import {
  deleteWatcher,
  insertWatcher,
  insertWatcherEvent,
  listEnabledWatchers,
  listWatchers,
  setWatcherEnabled,
  setWatcherGraphPredicate,
  updateWatcherLastChecked,
  updateWatcherLastFired,
} from "./watcher-store.ts";

describe("watcher-store", () => {
  test("listWatchers and listEnabledWatchers empty when schema below v8", () => {
    const db = new Database(":memory:");
    expect(listWatchers(db)).toEqual([]);
    expect(listEnabledWatchers(db)).toEqual([]);
  });

  test("insertWatcher throws when schema below v8", () => {
    const db = new Database(":memory:");
    const now = Date.now();
    expect(() =>
      insertWatcher(db, {
        name: "w",
        enabled: 1,
        condition_type: "alert_fired",
        condition_json: "{}",
        action_type: "notify",
        action_json: "{}",
        created_at: now,
      }),
    ).toThrow(/v8/);
  });

  test("deleteWatcher no-op when schema below v8", () => {
    const db = new Database(":memory:");
    expect(() => deleteWatcher(db, "any-id")).not.toThrow();
  });

  test("setWatcherEnabled returns false when schema below v8", () => {
    const db = new Database(":memory:");
    expect(setWatcherEnabled(db, "id", true)).toBe(false);
  });

  test("CRUD, enabled filter, last_checked / last_fired, watcher_event", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const t0 = 1_700_000_000_000;
    const id = insertWatcher(db, {
      name: "alerts",
      enabled: 1,
      condition_type: "alert_fired",
      condition_json: JSON.stringify({ filter: { service: "pagerduty" } }),
      action_type: "notify",
      action_json: "{}",
      created_at: t0,
    });
    expect(listWatchers(db)).toHaveLength(1);
    expect(listEnabledWatchers(db)).toHaveLength(1);

    expect(setWatcherEnabled(db, id, false)).toBe(true);
    expect(listEnabledWatchers(db)).toHaveLength(0);

    expect(setWatcherEnabled(db, id, true)).toBe(true);
    updateWatcherLastChecked(db, id, t0 + 100);
    updateWatcherLastFired(db, id, t0 + 200);
    insertWatcherEvent(db, id, t0 + 200, '{"matches":[]}', JSON.stringify({ ok: true }));

    const w = listWatchers(db)[0];
    expect(w?.last_checked_at).toBe(t0 + 100);
    expect(w?.last_fired_at).toBe(t0 + 200);

    const ev = db.query(`SELECT COUNT(*) as c FROM watcher_event WHERE watcher_id = ?`).get(id) as {
      c: number;
    };
    expect(ev.c).toBe(1);

    deleteWatcher(db, id);
    expect(listWatchers(db)).toHaveLength(0);
  });

  test("insertWatcher accepts explicit id", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const t0 = Date.now();
    const fixed = "00000000-0000-4000-8000-0000000000aa";
    const id = insertWatcher(db, {
      id: fixed,
      name: "with-id",
      enabled: 1,
      condition_type: "x",
      condition_json: "{}",
      action_type: "y",
      action_json: "{}",
      created_at: t0,
    });
    expect(id).toBe(fixed);
  });

  test("setWatcherGraphPredicate returns false when schema below v22", () => {
    const db = new Database(":memory:");
    expect(setWatcherGraphPredicate(db, "any-id", null)).toBe(false);
  });

  test("setWatcherGraphPredicate sets and clears graph_predicate_json", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const t0 = Date.now();
    const id = insertWatcher(db, {
      name: "gp-test",
      enabled: 1,
      condition_type: "alert_fired",
      condition_json: "{}",
      action_type: "notify",
      action_json: "{}",
      created_at: t0,
    });

    const predicateJson = JSON.stringify({
      relation: "owned_by",
      target: { type: "person", externalId: "gh:1" },
    });

    expect(setWatcherGraphPredicate(db, id, predicateJson)).toBe(true);
    const row = listWatchers(db).find((w) => w.id === id);
    expect(row?.graph_predicate_json).toBe(predicateJson);

    expect(setWatcherGraphPredicate(db, id, null)).toBe(true);
    const cleared = listWatchers(db).find((w) => w.id === id);
    expect(cleared?.graph_predicate_json).toBeNull();

    expect(setWatcherGraphPredicate(db, "no-such-id", predicateJson)).toBe(false);
  });
});
