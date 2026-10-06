import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { runIndexedSchemaMigrations } from "./runner.ts";

describe("V65 migration — user MCP grants", () => {
  test("CURRENT_SCHEMA_VERSION is at least 65", () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(65);
  });

  test("an existing V64 row gains deny-all defaults", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 64);
    db.run(
      `INSERT INTO user_mcp_connector (service_id, command, args_json, created_at) VALUES ('mcp_old', 'bun', '[]', 1)`,
    );
    runIndexedSchemaMigrations(db, 65);
    const row = db
      .query(
        "SELECT read_paths_json, net_hosts_json, model_access FROM user_mcp_connector WHERE service_id = 'mcp_old'",
      )
      .get() as { read_paths_json: string; net_hosts_json: string; model_access: number };
    expect(row).toEqual({ read_paths_json: "[]", net_hosts_json: "[]", model_access: 0 });
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
      65,
    );
    db.close();
  });
});
