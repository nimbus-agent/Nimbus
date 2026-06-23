import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { LocalIndex } from "../index/local-index.ts";
import {
  deleteUserMcpConnector,
  getUserMcpConnector,
  insertUserMcpConnector,
  listUserMcpConnectors,
  normalizeUserMcpServiceId,
  parseUserMcpCommandLine,
  USER_MCP_SERVICE_ID_PATTERN,
  validateUserMcpArgsJson,
} from "./user-mcp-store.ts";

/** Build an in-memory DB whose schema user_version is below v11 (no user_mcp_connector table). */
function makePreV11Db(): Database {
  const db = new Database(":memory:");
  // Version 0 — no migrations applied; readIndexedUserVersion returns 0
  return db;
}

describe("user-mcp-store", () => {
  test("normalizeUserMcpServiceId", () => {
    expect(normalizeUserMcpServiceId("mcp_demo")).toBe("mcp_demo");
    expect(normalizeUserMcpServiceId("MCP_DEMO")).toBe("mcp_demo");
    expect(normalizeUserMcpServiceId("demo")).toBeNull();
    expect(normalizeUserMcpServiceId("mcp_")).toBeNull();
  });

  test("USER_MCP_SERVICE_ID_PATTERN length bound", () => {
    const ok = `mcp_${"a".repeat(62)}`;
    expect(USER_MCP_SERVICE_ID_PATTERN.test(ok)).toBe(true);
    const tooLong = `mcp_${"a".repeat(63)}`;
    expect(USER_MCP_SERVICE_ID_PATTERN.test(tooLong)).toBe(false);
  });

  test("normalizeUserMcpServiceId trims surrounding whitespace before validation", () => {
    expect(normalizeUserMcpServiceId("  mcp_tool  ")).toBe("mcp_tool");
    expect(normalizeUserMcpServiceId("  bad  ")).toBeNull();
  });

  test("parseUserMcpCommandLine splits on whitespace", () => {
    expect(parseUserMcpCommandLine("bun run ./srv.ts")).toEqual({
      command: "bun",
      args: ["run", "./srv.ts"],
    });
  });

  test("parseUserMcpCommandLine handles a single-token command (no args)", () => {
    expect(parseUserMcpCommandLine("node")).toEqual({ command: "node", args: [] });
  });

  test("parseUserMcpCommandLine handles extra interior whitespace", () => {
    const result = parseUserMcpCommandLine("  npx   ts-node   --esm  ");
    expect(result.command).toBe("npx");
    expect(result.args).toEqual(["ts-node", "--esm"]);
  });

  test("listUserMcpConnectors after migration 11", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    db.run(
      `INSERT INTO user_mcp_connector (service_id, command, args_json, created_at) VALUES (?, ?, ?, ?)`,
      ["mcp_x", "echo", "[]", Date.now()],
    );
    const rows = listUserMcpConnectors(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.service_id).toBe("mcp_x");
  });

  test("listUserMcpConnectors returns empty array on a fresh empty store", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    expect(listUserMcpConnectors(db)).toEqual([]);
  });

  test("listUserMcpConnectors returns empty array when schema version < 11", () => {
    const db = makePreV11Db();
    expect(listUserMcpConnectors(db)).toEqual([]);
  });

  test("getUserMcpConnector returns null when schema version < 11", () => {
    const db = makePreV11Db();
    expect(getUserMcpConnector(db, "mcp_anything")).toBeNull();
  });

  test("insertUserMcpConnector throws when schema version < 11", () => {
    const db = makePreV11Db();
    expect(() =>
      insertUserMcpConnector(db, {
        service_id: "mcp_test",
        command: "node",
        args_json: "[]",
      }),
    ).toThrow(/schema v11/);
  });

  test("deleteUserMcpConnector returns false when schema version < 11", () => {
    const db = makePreV11Db();
    expect(deleteUserMcpConnector(db, "mcp_anything")).toBe(false);
  });

  test("insertUserMcpConnector auto-sets created_at when not provided", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const before = Date.now();
    insertUserMcpConnector(db, {
      service_id: "mcp_auto_ts",
      command: "bun",
      args_json: "[]",
      // created_at intentionally omitted — exercises the ?? Date.now() branch
    });
    const after = Date.now();
    const row = getUserMcpConnector(db, "mcp_auto_ts");
    expect(row).not.toBeNull();
    expect(row?.created_at).toBeGreaterThanOrEqual(before);
    expect(row?.created_at).toBeLessThanOrEqual(after);
  });

  test("parseUserMcpCommandLine throws on empty / whitespace-only input", () => {
    expect(() => parseUserMcpCommandLine("")).toThrow(/empty/);
    expect(() => parseUserMcpCommandLine("   \t  \n")).toThrow(/empty/);
  });

  test("validateUserMcpArgsJson serializes a string array (round-trip via JSON.parse)", () => {
    const args = ["run", "./srv.ts", "--flag"];
    const out = validateUserMcpArgsJson(args);
    expect(JSON.parse(out)).toEqual(args);
    expect(validateUserMcpArgsJson([])).toBe("[]");
  });

  test("get / insert / delete round-trip on schema v11+", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    expect(getUserMcpConnector(db, "mcp_demo")).toBeNull();
    insertUserMcpConnector(db, {
      service_id: "mcp_demo",
      command: "bun",
      args_json: '["run","./srv.ts"]',
      created_at: Date.now() - 1000,
    });
    const row = getUserMcpConnector(db, "mcp_demo");
    expect(row?.command).toBe("bun");
    expect(deleteUserMcpConnector(db, "mcp_demo")).toBe(true);
    expect(deleteUserMcpConnector(db, "mcp_demo")).toBe(false);
    expect(getUserMcpConnector(db, "mcp_demo")).toBeNull();
  });

  test("listUserMcpConnectors returns rows ordered by service_id", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const now = Date.now();
    db.run(
      `INSERT INTO user_mcp_connector (service_id, command, args_json, created_at) VALUES (?, ?, ?, ?)`,
      ["mcp_z", "node", "[]", now],
    );
    db.run(
      `INSERT INTO user_mcp_connector (service_id, command, args_json, created_at) VALUES (?, ?, ?, ?)`,
      ["mcp_a", "bun", "[]", now],
    );
    const rows = listUserMcpConnectors(db);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.service_id).toBe("mcp_a");
    expect(rows[1]?.service_id).toBe("mcp_z");
  });
});
