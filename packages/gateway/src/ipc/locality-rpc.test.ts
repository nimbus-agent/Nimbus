import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { createListenerRegistry } from "../locality/listener-registry.ts";
import { dispatchLocalityRpc, LocalityRpcError } from "./locality-rpc.ts";

function freshIndexedDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  return db;
}

test("returns a miss for an unrelated method", async () => {
  const db = freshIndexedDb();
  const out = await dispatchLocalityRpc(
    "engine.ask",
    {},
    {
      db,
      dbPath: ":memory:",
      registry: createListenerRegistry(),
      nowMs: 1,
    },
  );
  expect(out).toEqual({ kind: "miss" });
  db.close();
});

test("locality.report delegates to buildLocalityReport", async () => {
  const db = freshIndexedDb();
  const out = await dispatchLocalityRpc(
    "locality.report",
    {},
    {
      db,
      dbPath: ":memory:",
      registry: createListenerRegistry(),
      nowMs: 42,
    },
  );
  expect(out).toEqual({
    kind: "hit",
    value: { listeners: [], inventory: [], db: { path: ":memory:", bytes: 0 }, t1: 42 },
  });
  db.close();
});

test("throws a mapped error when dbPath is undefined, rather than fabricating a size", async () => {
  const db = freshIndexedDb();
  await expect(
    dispatchLocalityRpc(
      "locality.report",
      {},
      {
        db,
        dbPath: undefined,
        registry: createListenerRegistry(),
        nowMs: 1,
      },
    ),
  ).rejects.toThrow(LocalityRpcError);
  db.close();
});
