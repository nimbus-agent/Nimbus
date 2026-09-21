import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// M5: a wired `dbPath` whose MAIN file cannot be statted is mapped to the SAME -32603 shape as
// the unwired-`dbPath` case above, rather than propagating the raw `LocalityReportError`.
test("throws the same -32603 shape when the main db file cannot be statted", async () => {
  const db = freshIndexedDb();
  const missingPath = join(tmpdir(), "nimbus-locality-rpc-does-not-exist", "n.db");
  await expect(
    dispatchLocalityRpc(
      "locality.report",
      {},
      {
        db,
        dbPath: missingPath,
        registry: createListenerRegistry(),
        nowMs: 1,
      },
    ),
  ).rejects.toThrow(LocalityRpcError);
  db.close();
});

// Gate fix (coverage floor): `handleLocalityReport`'s catch maps ONLY a `LocalityReportError` to
// the -32603 shape above; anything else must propagate UNCHANGED (the `throw e;` rethrow arm).
// A bare, deliberately UNMIGRATED `Database` has no `item` table, so `collectInventory`'s own
// `SELECT … FROM item` throws a real SQLite error that has nothing to do with `dbBytes` at all —
// `dbPath: ":memory:"` makes the size path a no-op before any stat is ever attempted, so this is
// the one thrown value in this file guaranteed not to be a `LocalityReportError`.
test("rethrows a non-LocalityReportError (e.g. a missing item table) unchanged, never mapped to -32603", async () => {
  const db = new Database(":memory:"); // NOT migrated — no `item` table, deliberately
  try {
    const result = dispatchLocalityRpc(
      "locality.report",
      {},
      {
        db,
        dbPath: ":memory:",
        registry: createListenerRegistry(),
        nowMs: 1,
      },
    );
    await expect(result).rejects.not.toBeInstanceOf(LocalityRpcError);
    await expect(result).rejects.toThrow(/item/);
  } finally {
    db.close();
  }
});
