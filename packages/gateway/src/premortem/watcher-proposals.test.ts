import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { deleteWatcher, listWatchers, setWatcherEnabled } from "../automation/watcher-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { proposeWatchers } from "./watcher-proposals.ts";

function makeDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

const INPUT = { epicItemId: "jira:PROJ-120", services: ["billing"], nowMs: 1_700_000_000_000 };

describe("proposeWatchers", () => {
  test("creates one paused incident_opened watcher per service", () => {
    const db = makeDb();
    const out = proposeWatchers(db, INPUT);
    expect(out).toHaveLength(1);
    expect(out[0]?.state).toBe("created");
    const w = listWatchers(db)[0];
    expect(w?.enabled).toBe(0);
    expect(w?.condition_type).toBe("incident_opened");
    expect(JSON.parse(w?.condition_json ?? "{}")).toEqual({ filter: { service: "billing" } });
  });

  test("rule 1 — a re-run creates nothing the second time", () => {
    const db = makeDb();
    proposeWatchers(db, INPUT);
    const second = proposeWatchers(db, INPUT);
    expect(listWatchers(db)).toHaveLength(1);
    expect(second[0]?.state).toBe("already_present");
  });

  test("rule 2 — an armed watcher survives a re-run UN-PAUSED", () => {
    const db = makeDb();
    const id = proposeWatchers(db, INPUT)[0]?.watcherId as string;
    setWatcherEnabled(db, id, true);
    proposeWatchers(db, INPUT);
    expect(listWatchers(db)[0]?.enabled).toBe(1);
  });

  test("rule 3 — a deleted watcher stays deleted and is reported suppressed", () => {
    const db = makeDb();
    const id = proposeWatchers(db, INPUT)[0]?.watcherId as string;
    deleteWatcher(db, id);
    const again = proposeWatchers(db, INPUT);
    expect(listWatchers(db)).toHaveLength(0);
    expect(again[0]?.state).toBe("suppressed");
  });

  test("proposes NO deploy-failure watcher", () => {
    const db = makeDb();
    proposeWatchers(db, INPUT);
    expect(listWatchers(db).map((w) => w.condition_type)).not.toContain("deploy_failed");
  });
});
