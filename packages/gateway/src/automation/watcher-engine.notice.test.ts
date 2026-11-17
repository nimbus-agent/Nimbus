import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { upsertGraphEntity, upsertGraphRelation } from "../graph/relationship-graph.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import {
  evaluateWatchersAfterSync,
  evaluateWatchersStartupCatchUp,
  type WatcherNotice,
} from "./watcher-engine.ts";
import { insertWatcher, listWatchers } from "./watcher-store.ts";

const T0 = 1_700_000_000_000;

function makeDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

function addWatcher(db: Database, name: string, graphPredicateJson?: string): string {
  return insertWatcher(db, {
    name,
    enabled: 1,
    condition_type: "alert_fired",
    condition_json: JSON.stringify({ filter: { service: "sentry" } }),
    action_type: "notify",
    action_json: "{}",
    created_at: T0,
    ...(graphPredicateJson === undefined ? {} : { graph_predicate_json: graphPredicateJson }),
  });
}

function addAlert(db: Database, externalId: string, title: string): void {
  upsertIndexedItem(db, {
    service: "sentry",
    type: "alert",
    externalId,
    title,
    modifiedAt: T0 + 1000,
    syncedAt: T0 + 1000,
  });
}

describe("watcher-engine onNotice", () => {
  test("is called after updateWatcherLastFired with matchCount and no item text", () => {
    const db = makeDb();
    const id = addWatcher(db, "w1");
    addAlert(db, "a1", "<!channel> SECRET title https://evil.example");
    const seen: { notice: WatcherNotice; lastFiredAtCall: number | null }[] = [];
    evaluateWatchersAfterSync(db, "sentry", T0 + 5000, () => {}, {
      onNotice: (notice) => {
        const row = listWatchers(db).find((w) => w.id === id);
        seen.push({ notice, lastFiredAtCall: row?.last_fired_at ?? null });
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.lastFiredAtCall).toBe(T0 + 5000);
    expect(seen[0]?.notice).toEqual({
      watcherId: id,
      name: "w1",
      conditionType: "alert_fired",
      matchCount: 1,
      capped: false,
      firedAt: T0 + 5000,
    });
    expect(JSON.stringify(seen[0]?.notice)).not.toContain("SECRET");
  });

  test("capped is true when five candidates were selected", () => {
    const db = makeDb();
    addWatcher(db, "w1");
    for (let i = 0; i < 7; i += 1) addAlert(db, `a${i}`, `t${i}`);
    const seen: WatcherNotice[] = [];
    evaluateWatchersStartupCatchUp(db, T0 + 5000, () => {}, { onNotice: (n) => seen.push(n) });
    expect(seen[0]?.matchCount).toBe(5);
    expect(seen[0]?.capped).toBe(true);
  });

  test("capped follows the SQL candidate count, not the post-predicate count", () => {
    const db = makeDb();
    const predicate = JSON.stringify({
      relation: "owned_by",
      target: { type: "person", externalId: "gh:7" },
    });
    addWatcher(db, "w1", predicate);
    for (let i = 0; i < 5; i += 1) addAlert(db, `a${i}`, `t${i}`);
    const personId = upsertGraphEntity<string>(db, {
      type: "person",
      externalId: "gh:7",
      label: "Dev",
      service: "github",
    });
    for (const ext of ["a0", "a1"]) {
      const alertId = upsertGraphEntity(db, {
        type: "alert",
        externalId: ext,
        label: ext,
        service: "sentry",
      });
      upsertGraphRelation(db, personId, alertId, "authored", T0);
    }
    const seen: WatcherNotice[] = [];
    evaluateWatchersStartupCatchUp(db, T0 + 5000, () => {}, { onNotice: (n) => seen.push(n) });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ matchCount: 2, capped: true });
  });

  test("three candidates give capped = false", () => {
    const db = makeDb();
    addWatcher(db, "w1");
    for (let i = 0; i < 3; i += 1) addAlert(db, `a${i}`, `t${i}`);
    const seen: WatcherNotice[] = [];
    evaluateWatchersStartupCatchUp(db, T0 + 5000, () => {}, { onNotice: (n) => seen.push(n) });
    expect(seen[0]).toMatchObject({ matchCount: 3, capped: false });
  });

  test("a throwing onNotice does not stop the stamp or later watchers", () => {
    const db = makeDb();
    const a = addWatcher(db, "a");
    const b = addWatcher(db, "b");
    addAlert(db, "a1", "t");
    let calls = 0;
    expect(() =>
      evaluateWatchersAfterSync(db, "sentry", T0 + 5000, () => {}, {
        onNotice: () => {
          calls += 1;
          throw new Error("boom");
        },
      }),
    ).not.toThrow();
    expect(calls).toBe(2);
    for (const id of [a, b]) {
      expect(listWatchers(db).find((w) => w.id === id)?.last_fired_at).toBe(T0 + 5000);
    }
  });

  test("a throwing onFired does not stop the stamp or later watchers", () => {
    const db = makeDb();
    const a = addWatcher(db, "a");
    const b = addWatcher(db, "b");
    addAlert(db, "a1", "t");
    expect(() =>
      evaluateWatchersAfterSync(db, "sentry", T0 + 5000, () => {}, {
        onFired: () => {
          throw new Error("boom");
        },
      }),
    ).not.toThrow();
    for (const id of [a, b]) {
      expect(listWatchers(db).find((w) => w.id === id)?.last_fired_at).toBe(T0 + 5000);
    }
  });

  test("makeChatopsWatcherNotify is deleted from production source", () => {
    const root = join(import.meta.dir, "..");
    const src = readFileSync(join(root, "automation", "watcher-engine.ts"), "utf8");
    expect(src).not.toContain("makeChatopsWatcherNotify");
    expect(src).not.toContain("ChatopsWatcherNotifyDeps");
  });
});
