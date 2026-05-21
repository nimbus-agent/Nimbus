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

  test("parseUserMcpCommandLine splits on whitespace", () => {
    expect(parseUserMcpCommandLine("bun run ./srv.ts")).toEqual({
      command: "bun",
      args: ["run", "./srv.ts"],
    });
  });

  test("listUserMcpConnectors after migration 11", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    db.run(
      `INSERT INTO user_mcp_connector (service_id, command, args_json, created_at) VALUES (?, ?, ?, ?)`,
      ["mcp_x", "echo", "[]", Date.now()],
    );
    const rows = listUserMcpConnectors(db);
    expect(rows.length).toBe(1);
    expect(rows[0]?.service_id).toBe("mcp_x");
  });

  test("listUserMcpConnectors returns empty array on a fresh empty store", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    expect(listUserMcpConnectors(db)).toEqual([]);
  });

  test("parseUserMcpCommandLine throws on empty / whitespace-only input", () => {
    expect(() => parseUserMcpCommandLine("")).toThrow(/empty/);
    expect(() => parseUserMcpCommandLine("   \t  \n")).toThrow(/empty/);
  });

  test("validateUserMcpArgsJson serializes a string array (round-trip via JSON.parse)", () => {
    const args = ["run", "./srv.ts", "--flag"];
    const out = validateUserMcpArgsJson(args);
    expect(JSON.parse(out)).toEqual(args);
    // Empty args is a valid serialization too.
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
      created_at: 1_700_000_000_000,
    });
    const row = getUserMcpConnector(db, "mcp_demo");
    expect(row?.command).toBe("bun");
    expect(row?.created_at).toBe(1_700_000_000_000);
    // Delete returns true on a hit, false on a miss (already-deleted row).
    expect(deleteUserMcpConnector(db, "mcp_demo")).toBe(true);
    expect(deleteUserMcpConnector(db, "mcp_demo")).toBe(false);
    expect(getUserMcpConnector(db, "mcp_demo")).toBeNull();
  });
});
