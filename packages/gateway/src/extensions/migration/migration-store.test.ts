import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { openMemoryIndexDatabase } from "../../testing/bun-test-support.ts";
import {
  finishMigration,
  getMigration,
  getMigrationByLegacyService,
  listMigrations,
  pendingMigrationForExtension,
  recordMigrationFailed,
  recordMigrationPrepared,
  reopenDeclinedMigration,
} from "./migration-store.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

function open(): Database {
  const db = openMemoryIndexDatabase();
  dbs.push(db);
  return db;
}

const PREPARED = {
  id: "m1",
  legacyServiceId: "fixture_reader",
  extensionId: "com.example.reader",
  version: "1.0.0",
  treeDigest: "d".repeat(64),
  stagePath: "/stage/m1/pkg",
};

describe("migration-store", () => {
  test("a prepared row reads back awaiting_approval, by id and by legacy service", () => {
    const db = open();
    expect(recordMigrationPrepared(db, PREPARED, 10)).toBe(true);
    const row = getMigration(db, "m1");
    expect(row).toEqual({
      ...PREPARED,
      state: "awaiting_approval",
      error: null,
      createdAt: 10,
      updatedAt: 10,
    });
    expect(getMigrationByLegacyService(db, "fixture_reader")).toEqual(row);
    expect(pendingMigrationForExtension(db, "com.example.reader")).toEqual(row);
    expect(listMigrations(db)).toEqual(row === undefined ? [] : [row]);
  });

  test("one row per legacy service: a second write keeps the first id and creation time", () => {
    const db = open();
    recordMigrationPrepared(db, PREPARED, 10);
    recordMigrationFailed(
      db,
      {
        id: "m2",
        legacyServiceId: "fixture_reader",
        extensionId: "com.example.reader",
        error: "x",
      },
      20,
    );
    expect(listMigrations(db)).toHaveLength(1);
    const row = getMigrationByLegacyService(db, "fixture_reader");
    expect(row?.id).toBe("m1");
    expect(row?.createdAt).toBe(10);
    expect(row?.updatedAt).toBe(20);
    expect(row?.state).toBe("failed");
    expect(row?.stagePath).toBeNull();
    expect(row?.treeDigest).toBeNull();
    expect(pendingMigrationForExtension(db, "com.example.reader")).toBeUndefined();
  });

  test("approved and declined are terminal: neither a prepare nor a failure rewrites them", () => {
    const db = open();
    for (const to of ["approved", "declined"] as const) {
      const legacy = `svc_${to}`;
      recordMigrationPrepared(db, { ...PREPARED, id: to, legacyServiceId: legacy }, 1);
      expect(finishMigration(db, to, to, null, 2)).toBe(true);
      expect(recordMigrationPrepared(db, { ...PREPARED, id: to, legacyServiceId: legacy }, 3)).toBe(
        false,
      );
      expect(
        recordMigrationFailed(
          db,
          { id: to, legacyServiceId: legacy, extensionId: PREPARED.extensionId, error: "e" },
          4,
        ),
      ).toBe(false);
      const row = getMigration(db, to);
      expect(row?.state).toBe(to);
      expect(row?.stagePath).toBeNull();
      expect(row?.updatedAt).toBe(2);
    }
  });

  test("finishMigration moves only an awaiting_approval row", () => {
    const db = open();
    recordMigrationPrepared(db, PREPARED, 1);
    expect(finishMigration(db, "m1", "failed", "digest mismatch", 2)).toBe(true);
    expect(getMigration(db, "m1")?.error).toBe("digest mismatch");
    expect(finishMigration(db, "m1", "approved", null, 3)).toBe(false);
    expect(finishMigration(db, "missing", "declined", null, 3)).toBe(false);
    expect(getMigration(db, "m1")?.state).toBe("failed");
  });
});

describe("reopenDeclinedMigration", () => {
  test("reopens only a declined row", () => {
    const db = open();
    recordMigrationPrepared(db, PREPARED, 1);
    expect(reopenDeclinedMigration(db, "m1", 2)).toBe(false);
    finishMigration(db, "m1", "declined", null, 3);
    expect(reopenDeclinedMigration(db, "m1", 4)).toBe(true);
    expect(getMigration(db, "m1")?.state).toBe("failed");
    // Prepare may now rewrite it.
    expect(recordMigrationPrepared(db, PREPARED, 5)).toBe(true);
    finishMigration(db, "m1", "approved", null, 6);
    expect(reopenDeclinedMigration(db, "m1", 7)).toBe(false);
    expect(getMigration(db, "m1")?.state).toBe("approved");
  });
});
