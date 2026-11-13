import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { upsertIndexedItem } from "../index/item-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { DAY_MS } from "./cost-item-contract.ts";
import { pruneCostRows, startFinopsRetention } from "./cost-retention.ts";

const NOW = Date.UTC(2026, 10, 12);
const dbs: Database[] = [];

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  dbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

function seed(
  db: Database,
  opts: { service?: string; type?: string; id: string; ageDays: number },
): void {
  const periodEndMs = NOW - opts.ageDays * DAY_MS;
  upsertIndexedItem(db, {
    service: opts.service ?? "vantage",
    type: opts.type ?? "cost_allocation",
    externalId: opts.id,
    title: opts.id,
    bodyPreview: opts.id,
    modifiedAt: periodEndMs,
    metadata: { periodStartMs: periodEndMs - DAY_MS, periodEndMs },
    syncedAt: NOW,
  });
}

const ids = (db: Database): string[] =>
  (db.query("SELECT id FROM item ORDER BY id").all() as { id: string }[]).map((r) => r.id);

describe("pruneCostRows", () => {
  test("deletes cost rows past retain_days and keeps newer ones", () => {
    const db = freshDb();
    seed(db, { id: "old", ageDays: 401 });
    seed(db, { id: "edge", ageDays: 400 });
    seed(db, { id: "new", ageDays: 10 });
    const deleted = pruneCostRows(db, { retainDays: 400, nowMs: NOW });
    expect(deleted).toBe(1);
    expect(ids(db)).toEqual(["vantage:edge", "vantage:new"]);
  });

  test("never touches a cost_recommendation, however old", () => {
    const db = freshDb();
    seed(db, { id: "rec", type: "cost_recommendation", ageDays: 900 });
    expect(pruneCostRows(db, { retainDays: 30, nowMs: NOW })).toBe(0);
    expect(ids(db)).toEqual(["vantage:rec"]);
  });

  test("a cost_allocation of another service id is pruned only if it is one of the five", () => {
    const db = freshDb();
    seed(db, { service: "kubecost", id: "k", ageDays: 500 });
    seed(db, { service: "github", type: "cost_allocation", id: "g", ageDays: 500 });
    pruneCostRows(db, { retainDays: 400, nowMs: NOW });
    expect(ids(db)).toEqual(["github:g"]);
  });

  test("loops in batches of 1000 until none remain", () => {
    const db = freshDb();
    db.transaction(() => {
      for (let i = 0; i < 2500; i += 1) seed(db, { id: `r${String(i)}`, ageDays: 500 });
    })();
    expect(pruneCostRows(db, { retainDays: 400, nowMs: NOW })).toBe(2500);
    expect(ids(db)).toEqual([]);
  });

  test("deletes through the item-store delete chokepoint", () => {
    const db = freshDb();
    seed(db, { id: "old", ageDays: 500 });
    const seen: string[] = [];
    pruneCostRows(db, {
      retainDays: 400,
      nowMs: NOW,
      deleteItem: (d, key) => {
        seen.push(key);
        d.run("DELETE FROM item WHERE id = ?", [key]);
      },
    });
    expect(seen).toEqual(["vantage:old"]);
  });

  test("a non-positive retain_days prunes nothing", () => {
    const db = freshDb();
    seed(db, { id: "old", ageDays: 5000 });
    expect(pruneCostRows(db, { retainDays: 0, nowMs: NOW })).toBe(0);
    expect(ids(db)).toEqual(["vantage:old"]);
  });
});

describe("startFinopsRetention", () => {
  test("prunes once at boot and the stop handle clears the timer", () => {
    const db = freshDb();
    seed(db, { id: "old", ageDays: 500 });
    const handle = startFinopsRetention(db, { retainDays: 400, nowMs: () => NOW });
    expect(ids(db)).toEqual([]);
    handle.stop();
  });

  test("a throwing prune is caught and the next tick still runs", async () => {
    const db = freshDb();
    let calls = 0;
    const handle = startFinopsRetention(db, {
      retainDays: 400,
      nowMs: () => NOW,
      intervalMs: 5,
      prune: () => {
        calls += 1;
        throw new Error("boom");
      },
    });
    const start = Date.now();
    while (calls < 2 && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 5));
    }
    handle.stop();
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
