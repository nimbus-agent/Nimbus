import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  getUserMcpConnector,
  insertUserMcpConnector,
  listModelAccessibleUserMcpIds,
  listUserMcpConnectors,
} from "../../connectors/user-mcp-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { maxRegisteredIndexedSchemaVersion, runIndexedSchemaMigrations } from "./runner.ts";

type Column = { name: string; type: string; notnull: number; dflt_value: string | null };

function columns(db: Database): Column[] {
  return db.query("PRAGMA table_info(user_mcp_connector)").all() as Column[];
}

const ROW = {
  service_id: "mcp_notes",
  command: "/usr/bin/notes",
  args_json: "[]",
  read_paths_json: '["/data"]',
  net_hosts_json: "[]",
  model_access: 1,
  created_at: 5,
};

describe("V98 migration - user_mcp_connector.write_paths_json (Phase 28 AD5b)", () => {
  test("a fresh database has the column, TEXT NOT NULL DEFAULT '[]', and the constant agrees", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
      expect(columns(db).find((c) => c.name === "write_paths_json")).toMatchObject({
        type: "TEXT",
        notnull: 1,
        dflt_value: "'[]'",
      });
      expect(CURRENT_SCHEMA_VERSION).toBe(maxRegisteredIndexedSchemaVersion());
      expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(98);
    } finally {
      db.close();
    }
  });

  test("a V97 database with a registered server upgrades, and that server gains NO write directory", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 97);
      expect(columns(db).map((c) => c.name)).not.toContain("write_paths_json");
      insertUserMcpConnector(db, ROW);
      // Read through the store at V97: the field is there and empty.
      expect(getUserMcpConnector(db, "mcp_notes")?.write_paths_json).toBe("[]");
      runIndexedSchemaMigrations(db, 98);
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 98 });
      expect(getUserMcpConnector(db, "mcp_notes")).toEqual({ ...ROW, write_paths_json: "[]" });
      expect(listModelAccessibleUserMcpIds(db)).toEqual(["mcp_notes"]);
    } finally {
      db.close();
    }
  });

  test("the step can run again after user_version is rewound (the column probe)", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 98);
      insertUserMcpConnector(db, { ...ROW, write_paths_json: '["/out"]' });
      db.run("PRAGMA user_version = 97");
      runIndexedSchemaMigrations(db, 98);
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 98 });
      expect(columns(db).filter((c) => c.name === "write_paths_json")).toHaveLength(1);
      expect(getUserMcpConnector(db, "mcp_notes")?.write_paths_json).toBe('["/out"]');
    } finally {
      db.close();
    }
  });

  test("the store at V98: a write directory round-trips, and an omitted one is none", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 98);
      insertUserMcpConnector(db, { ...ROW, write_paths_json: '["/out","/more"]' });
      insertUserMcpConnector(db, { ...ROW, service_id: "mcp_plain" });
      expect(listUserMcpConnectors(db).map((r) => [r.service_id, r.write_paths_json])).toEqual([
        ["mcp_notes", '["/out","/more"]'],
        ["mcp_plain", "[]"],
      ]);
    } finally {
      db.close();
    }
  });

  test("the store at V97 refuses an insert that carries a write directory, and stores nothing", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 97);
      expect(() => insertUserMcpConnector(db, { ...ROW, write_paths_json: '["/out"]' })).toThrow(
        "write directories require schema v98+",
      );
      expect(listUserMcpConnectors(db)).toEqual([]);
      insertUserMcpConnector(db, { ...ROW, write_paths_json: "[]" });
      expect(listUserMcpConnectors(db)).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
