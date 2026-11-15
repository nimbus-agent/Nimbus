// The agent-door enable prompt for a user MCP server that holds a write directory (I15; AD5b-2).
import { describe, expect, test } from "bun:test";

import {
  USER_MCP_WRITE_HEADER,
  USER_MCP_WRITE_WARNING_LINES,
} from "../../engine/user-mcp-write-lines.ts";
import { enableWritesPromptLines } from "./enable-prompt.ts";

const SHA = `3fa9c1d2e4b7${"0".repeat(52)}`;
const PAYLOAD = {
  door: "agent",
  userMcp: true,
  service: "mcp_notes",
  registeredAt: Date.UTC(2026, 10, 1),
  readPaths: ["/data/notes"],
  netHosts: [],
  modelAccess: false,
  tools: [
    {
      toolId: "append",
      state: "will_be_approved",
      sha12: SHA.slice(0, 12),
      description: "adds a note",
    },
  ],
};

describe("the agent-door enable prompt of a user MCP server", () => {
  const plain = enableWritesPromptLines(PAYLOAD);

  test("the fixture is the shape the prompt renders (the control for the cases below)", () => {
    expect(plain).toBeDefined();
    expect(plain).toContain("  write: none beyond its own sandbox directory");
    expect(plain?.join("\n")).not.toContain("WRITE ACCESS");
  });

  test("with a write directory: the write block replaces the none line, in the same place", () => {
    const lines = enableWritesPromptLines({
      ...PAYLOAD,
      writePaths: ["/home/me/work/out"],
      writePlatform: "win32",
    });
    expect(lines).toBeDefined();
    expect(lines).not.toContain("  write: none beyond its own sandbox directory");
    const header = lines?.indexOf(USER_MCP_WRITE_HEADER) ?? -1;
    expect(header).toBe(plain?.indexOf("  write: none beyond its own sandbox directory") ?? -2);
    expect(lines?.[header + 1]).toBe("  write: /home/me/work/out");
    expect(lines).toContain("On Windows it cannot delete or rename there.");
    for (const w of USER_MCP_WRITE_WARNING_LINES) expect(lines).toContain(w);
    // Everything after the block is what the plain prompt has after its none line.
    const after = (ls: readonly string[] | undefined, marker: string): string[] =>
      (ls ?? []).slice((ls ?? []).findIndex((l) => l.startsWith(marker)));
    expect(after(lines, "Also registered for your own model")).toEqual(
      after(plain, "Also registered for your own model"),
    );
  });

  test("an empty list is the plain prompt, byte for byte", () => {
    expect(enableWritesPromptLines({ ...PAYLOAD, writePaths: [] })).toEqual(plain);
  });

  test("a write list that is not strings, or one with no platform, renders nothing (the gate then refuses)", () => {
    expect(enableWritesPromptLines({ ...PAYLOAD, writePaths: [1] })).toBeUndefined();
    expect(enableWritesPromptLines({ ...PAYLOAD, writePaths: "/x" })).toBeUndefined();
    expect(enableWritesPromptLines({ ...PAYLOAD, writePaths: ["/x"] })).toBeUndefined();
  });
});
