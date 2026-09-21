import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { upsertIndexedItemForSync } from "../index/item-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { createListenerRegistry } from "./listener-registry.ts";
import { buildLocalityReport } from "./locality-report.ts";

function freshIndexedDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  return db;
}

test("bytes sums main + wal + shm and tolerates missing files", () => {
  const db = freshIndexedDb();
  const sizes: Record<string, number> = { "/d/n.db": 100, "/d/n.db-wal": 40 };
  const r = buildLocalityReport({
    db,
    dbPath: "/d/n.db",
    registry: createListenerRegistry(),
    nowMs: 9,
    statSize: (p) => sizes[p] ?? null,
  });
  expect(r.db).toEqual({ path: "/d/n.db", bytes: 140 });
  expect(r.t1).toBe(9);
  db.close();
});

test(":memory: reports zero bytes and never stats", () => {
  const db = freshIndexedDb();
  const r = buildLocalityReport({
    db,
    dbPath: ":memory:",
    registry: createListenerRegistry(),
    nowMs: 1,
    statSize: () => {
      throw new Error("must not be called");
    },
  });
  expect(r.db).toEqual({ path: ":memory:", bytes: 0 });
  db.close();
});

test("a non-loopback listener is reported as non-loopback; an unopened one is absent", () => {
  const db = freshIndexedDb();
  const reg = createListenerRegistry();
  reg.register(() => ({ name: "lan", address: "192.168.1.20:7443", loopback: false }));
  reg.register(() => null);
  const r = buildLocalityReport({ db, dbPath: ":memory:", registry: reg, nowMs: 1 });
  expect(r.listeners).toEqual([{ name: "lan", address: "192.168.1.20:7443", loopback: false }]);
  db.close();
});

test("inventory counts items per service, largest first", () => {
  const db = freshIndexedDb();
  upsertIndexedItemForSync(
    { db, depth: "full" },
    {
      service: "github",
      type: "pull_request",
      externalId: "pr-1",
      title: "t",
      body: "b",
      modifiedAt: 1,
      syncedAt: 1,
    },
  );
  upsertIndexedItemForSync(
    { db, depth: "full" },
    {
      service: "github",
      type: "pull_request",
      externalId: "pr-2",
      title: "t",
      body: "b",
      modifiedAt: 1,
      syncedAt: 1,
    },
  );
  upsertIndexedItemForSync(
    { db, depth: "full" },
    {
      service: "slack",
      type: "message",
      externalId: "m-1",
      title: "t",
      body: "b",
      modifiedAt: 1,
      syncedAt: 1,
    },
  );
  const r = buildLocalityReport({
    db,
    dbPath: ":memory:",
    registry: createListenerRegistry(),
    nowMs: 1,
  });
  expect(r.inventory).toEqual([
    { service: "github", items: 2 },
    { service: "slack", items: 1 },
  ]);
  db.close();
});
