import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import type { WatcherFiredPayload } from "../ipc/gateway-events.ts";
import { evaluateWatchersAfterSync } from "./watcher-engine.ts";
import { insertWatcher, listWatchers } from "./watcher-store.ts";

/**
 * A watcher whose `condition_json` parses but is not an OBJECT (`null`, an array, a number, a
 * string) must be skipped without disturbing its siblings — `null` in particular would otherwise
 * reach `cond["filter"]` and throw out of the loop, silencing every watcher evaluated after it.
 */

const T0 = 1_700_000_000_000;
const dbs: Database[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

function makeDb(): Database {
  const db = new Database(":memory:");
  dbs.push(db);
  LocalIndex.ensureSchema(db);
  return db;
}

function alertWatcher(db: Database, name: string, conditionJson: string): string {
  return insertWatcher(db, {
    name,
    enabled: 1,
    condition_type: "alert_fired",
    condition_json: conditionJson,
    action_type: "notify",
    action_json: "{}",
    created_at: T0,
  });
}

function seedAlert(db: Database): void {
  upsertIndexedItem(db, {
    service: "pagerduty",
    type: "alert",
    externalId: "inc-7",
    title: "Checkout 500s",
    modifiedAt: T0 + 5_000,
    syncedAt: T0 + 5_000,
  });
}

describe("watcher-engine — a condition that is JSON but not an object", () => {
  for (const [label, conditionJson] of [
    ["null", "null"],
    ["an array", JSON.stringify([{ filter: { service: "pagerduty" } }])],
    ["a number", "42"],
    ["a string", JSON.stringify("filter")],
  ] as const) {
    test(`${label} never fires, is still stamped checked, and does not stop its siblings`, () => {
      const db = makeDb();
      seedAlert(db);
      // Named to sort FIRST — the loop walks watchers `ORDER BY name` — so a throw on it would
      // also stop the sibling below from ever being evaluated.
      const bad = alertWatcher(db, `bad-${label}`, conditionJson);
      const good = alertWatcher(db, "good", JSON.stringify({ filter: { service: "pagerduty" } }));
      const bodies: string[] = [];
      const fired: WatcherFiredPayload[] = [];
      const evalAt = T0 + 9_000;

      const notify = (_title: string, body: string): void => {
        bodies.push(body);
      };
      evaluateWatchersAfterSync(db, "pagerduty", evalAt, notify, {
        onFired: (p) => {
          fired.push(p);
        },
      });

      expect(fired.map((f) => f.watcherId)).toEqual([good]);
      expect(bodies).toEqual(["good: pagerduty: Checkout 500s"]);
      const badRow = listWatchers(db).find((w) => w.id === bad);
      expect(badRow?.last_checked_at).toBe(evalAt);
      expect(badRow?.last_fired_at).toBeNull();
      const events = db
        .query("SELECT COUNT(*) AS n FROM watcher_event WHERE watcher_id = ?")
        .get(bad) as { n: number };
      expect(events.n).toBe(0);
    });
  }
});
