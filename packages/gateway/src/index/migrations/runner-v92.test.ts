import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { maxRegisteredIndexedSchemaVersion, runIndexedSchemaMigrations } from "./runner.ts";

const INSERT =
  "INSERT INTO chat_read_marker (service, channel_id, channel_kind, last_read_ts, captured_at) VALUES (?, ?, ?, ?, ?)";

describe("V92 migration - Slack read markers", () => {
  test("a V91 database gains an empty chat_read_marker and the schema constant agrees", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 91);
      runIndexedSchemaMigrations(db, 92);
      expect(db.query("SELECT count(*) AS n FROM chat_read_marker").get()).toEqual({ n: 0 });
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 92 });
      expect(CURRENT_SCHEMA_VERSION).toBe(maxRegisteredIndexedSchemaVersion());
    } finally {
      db.close();
    }
  });

  test("the channel_kind CHECK refuses an unknown kind and accepts the four Slack kinds", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 92);
      expect(() => db.run(INSERT, ["slack", "C0", "bogus", "1700000000.000001", 1])).toThrow();
      for (const [i, kind] of ["public_channel", "private_channel", "im", "mpim"].entries()) {
        db.run(INSERT, ["slack", `C${String(i)}`, kind, "1700000000.000001", 1]);
      }
      expect(db.query("SELECT count(*) AS n FROM chat_read_marker").get()).toEqual({ n: 4 });
    } finally {
      db.close();
    }
  });

  test("the primary key is (service, channel_id)", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 92);
      db.run(INSERT, ["slack", "C1", "im", "1700000000.000001", 1]);
      expect(() => db.run(INSERT, ["slack", "C1", "im", "1700000000.000002", 2])).toThrow();
      db.run(INSERT, ["other", "C1", "im", "1700000000.000001", 1]);
      expect(db.query("SELECT count(*) AS n FROM chat_read_marker").get()).toEqual({ n: 2 });
    } finally {
      db.close();
    }
  });

  test("every column is NOT NULL", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 92);
      const cols = db.query("PRAGMA table_info(chat_read_marker)").all() as Array<{
        name: string;
        notnull: number;
      }>;
      expect(cols.map((c) => c.name)).toEqual([
        "service",
        "channel_id",
        "channel_kind",
        "last_read_ts",
        "captured_at",
      ]);
      expect(cols.every((c) => c.notnull === 1)).toBe(true);
    } finally {
      db.close();
    }
  });

  test("re-running the step is idempotent", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 92);
      db.run("PRAGMA user_version = 91");
      expect(() => runIndexedSchemaMigrations(db, 92)).not.toThrow();
    } finally {
      db.close();
    }
  });
});
