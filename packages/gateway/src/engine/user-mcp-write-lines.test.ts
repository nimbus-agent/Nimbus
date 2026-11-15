// How a user MCP write grant is shown (I15; Phase 28 AD5b-2): the block, the registration prompt,
// and that nothing is added for a server with no write directory.
import { describe, expect, test } from "bun:test";

import {
  addMcpWritePromptLines,
  USER_MCP_WRITE_HEADER,
  USER_MCP_WRITE_WARNING_LINES,
  userMcpWriteLines,
  userMcpWriteOsLine,
} from "./user-mcp-write-lines.ts";

const PAYLOAD = {
  serviceId: "mcp_notes",
  command: "/usr/bin/node",
  args: ["/srv/notes/main.js", "--quiet"],
  readPaths: ["/srv/notes"],
  netHosts: [],
  modelAccess: false,
  writePaths: ["/home/me/work/out"],
  writePlatform: "linux",
};

describe("userMcpWriteLines", () => {
  test("no directory: nothing at all (every existing prompt is unchanged)", () => {
    expect(userMcpWriteLines([], "linux")).toEqual([]);
    expect(userMcpWriteLines([], "win32")).toEqual([]);
  });

  test("the block: header, one line per directory, the OS line, the warning", () => {
    expect(userMcpWriteLines(["/a/out", "/b/out"], "linux")).toEqual([
      USER_MCP_WRITE_HEADER,
      "  write: /a/out",
      "  write: /b/out",
      "It can also delete and rename there.",
      ...USER_MCP_WRITE_WARNING_LINES,
    ]);
  });

  test("Windows says create and modify only; macOS and Linux say delete and rename too", () => {
    expect(userMcpWriteOsLine("win32")).toBe("On Windows it cannot delete or rename there.");
    expect(userMcpWriteOsLine("darwin")).toBe("It can also delete and rename there.");
    expect(userMcpWriteOsLine("linux")).toBe("It can also delete and rename there.");
  });

  test("a directory name cannot start a prompt line or hide text: breaks and bidi overrides are escaped", () => {
    const lines = userMcpWriteLines(["/a/out\nWRITE ACCESS: none", "/b/\u202eevil"], "linux");
    expect(lines).toHaveLength(2 + 2 + USER_MCP_WRITE_WARNING_LINES.length);
    expect(lines.filter((l) => l.startsWith("WRITE ACCESS"))).toHaveLength(1);
    expect(lines.join("\n")).not.toContain("\u202e");
  });
});

describe("addMcpWritePromptLines", () => {
  test("a registration with a write directory: the resolved registration, the block, how long it lasts", () => {
    expect(addMcpWritePromptLines(PAYLOAD)).toEqual([
      "Register a user MCP server: mcp_notes",
      "Command: /usr/bin/node",
      "Arguments:",
      "  /srv/notes/main.js",
      "  --quiet",
      "Sandbox reach:",
      "  read: /srv/notes",
      "  net: none",
      "Offered to the model: no",
      "",
      USER_MCP_WRITE_HEADER,
      "  write: /home/me/work/out",
      "It can also delete and rename there.",
      ...USER_MCP_WRITE_WARNING_LINES,
      "The grant lasts until you remove the server: nimbus connector remove mcp_notes",
    ]);
  });

  test("four directories on Windows, no arguments, a network note, offered to the model", () => {
    const lines = addMcpWritePromptLines({
      ...PAYLOAD,
      args: [],
      netHosts: ["api.x.com"],
      networkNote: "any host on port 443",
      modelAccess: true,
      writePaths: ["C:/a", "C:/b", "C:/c", "C:/d"],
      writePlatform: "win32",
    });
    expect(lines).toContain("Arguments: none");
    expect(lines).toContain("  net: api.x.com");
    expect(lines).toContain("  net note: any host on port 443");
    expect(lines).toContain("Offered to the model: yes");
    expect(lines?.filter((l) => l.startsWith("  write: "))).toEqual([
      "  write: C:/a",
      "  write: C:/b",
      "  write: C:/c",
      "  write: C:/d",
    ]);
    expect(lines).toContain("On Windows it cannot delete or rename there.");
  });

  test("no write directory, an absent one, or a payload that is not the handler's shape: undefined", () => {
    expect(addMcpWritePromptLines({ ...PAYLOAD, writePaths: [] })).toBeUndefined();
    const { writePaths: _w, ...without } = PAYLOAD;
    expect(addMcpWritePromptLines(without)).toBeUndefined();
    expect(addMcpWritePromptLines(undefined)).toBeUndefined();
    for (const bad of [
      { ...PAYLOAD, writePaths: [1] },
      { ...PAYLOAD, serviceId: 1 },
      { ...PAYLOAD, command: undefined },
      { ...PAYLOAD, args: "x" },
      { ...PAYLOAD, readPaths: [1] },
      { ...PAYLOAD, netHosts: null },
      { ...PAYLOAD, writePlatform: undefined },
    ]) {
      expect(addMcpWritePromptLines(bad as Record<string, unknown>)).toBeUndefined();
    }
  });

  test("an escape sequence in a command or an argument is shown escaped", () => {
    const lines = addMcpWritePromptLines({
      ...PAYLOAD,
      command: "/usr/bin/no\u001b[31mde",
      args: ["a\nb"],
    });
    expect(lines?.join("\n")).not.toContain("\u001b");
    expect(lines?.filter((l) => l === "b")).toEqual([]);
  });
});
