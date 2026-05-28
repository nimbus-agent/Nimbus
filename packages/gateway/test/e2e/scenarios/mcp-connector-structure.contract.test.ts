import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MCP_ROOT = join(import.meta.dir, "..", "..", "..", "..", "mcp-connectors");

describe("MCP connector package layout (contract)", () => {
  test("no src/auth.ts under packages/mcp-connectors/*", () => {
    expect(existsSync(MCP_ROOT)).toBe(true);
    for (const name of readdirSync(MCP_ROOT)) {
      const authTs = join(MCP_ROOT, name, "src", "auth.ts");
      expect(existsSync(authTs)).toBe(false);
    }
  });
});
