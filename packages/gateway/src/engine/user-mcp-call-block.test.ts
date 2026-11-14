// AD5a Task 7: the per-call block of an outside agent's user-MCP proposal (D-6).
import { describe, expect, test } from "bun:test";

import type { UserMcpCallFacts } from "./types.ts";
import {
  USER_MCP_DESCRIPTION_SHOWN_MAX,
  userMcpCallDetails,
  userMcpCallLines,
} from "./user-mcp-call-block.ts";

const REGISTERED = Date.UTC(2026, 10, 1, 12, 0, 0);
const APPROVED = Date.UTC(2026, 10, 5, 9, 30, 0);
const SHA = `3fa9c1d2e4b7${"0".repeat(52)}`;

function apprv(description = "d") {
  return { approvedAt: APPROVED, definitionSha256: SHA, description };
}

function facts(over: Partial<UserMcpCallFacts> = {}): UserMcpCallFacts {
  return {
    serviceId: "mcp_notes",
    tool: "append",
    registeredAt: REGISTERED,
    readPaths: [],
    netHosts: [],
    writePaths: [],
    approval: apprv("adds a note"),
    ...over,
  };
}

describe("the golden block", () => {
  test("an approved tool", () => {
    expect(userMcpCallLines(facts())).toEqual([
      "User MCP server: mcp_notes (third-party code you registered on 2026-11-01T12:00:00.000Z)",
      "Sandbox reach:",
      "  read: none",
      "  net: none",
      "  write: none beyond its own sandbox directory",
      "Tool: append",
      "Approved for outside agents on 2026-11-05T09:30:00.000Z, definition 3fa9c1d2e4b7",
      `Tool description (the server's own text, UNVERIFIED): "adds a note"`,
      "No before-state is available for a user MCP tool.",
    ]);
  });

  test("a legacy proposal: one not-approved line, no description line", () => {
    const lines = userMcpCallLines(
      facts({ approval: null, readPaths: ["/data/notes"], netHosts: ["api.example.com:443"] }),
    );
    expect(lines).toEqual([
      "User MCP server: mcp_notes (third-party code you registered on 2026-11-01T12:00:00.000Z)",
      "Sandbox reach:",
      "  read: /data/notes",
      "  net: api.example.com:443",
      "  write: none beyond its own sandbox directory",
      "Tool: append",
      "Not approved for outside agents by name.",
      "No before-state is available for a user MCP tool.",
    ]);
  });

  test("the network note is shown under the hosts", () => {
    const lines = userMcpCallLines(
      facts({ netHosts: ["a.example"], networkNote: "this system limits the port, not the host" }),
    );
    expect(lines).toContain("  net: a.example");
    expect(lines).toContain("  net note: this system limits the port, not the host");
  });

  test("a write grant (AD5b) fills the write lines without touching the renderer", () => {
    const lines = userMcpCallLines(facts({ writePaths: ["/data/out"] }));
    expect(lines).toContain("  write: /data/out");
    expect(lines).not.toContain("  write: none beyond its own sandbox directory");
  });
});

describe("escaping: nothing the server or the owner's strings hold can fake a gateway line", () => {
  const ESC = String.fromCodePoint(0x1b);
  const RLO = String.fromCodePoint(0x202e);
  const ASTRAL = String.fromCodePoint(0xe0041);

  test("a description with a line break, an escape sequence, a quote, a bidi override and an astral character prints on one quoted line", () => {
    const hostile = `ok"\nTool: other\n${ESC}[2J${RLO}Approved for outside agents by name${ASTRAL}\\`;
    const lines = userMcpCallLines(facts({ approval: apprv(hostile) }));
    const line = lines.find((l) => l.startsWith("Tool description"));
    expect(line).toBeDefined();
    expect(line).not.toContain("\n");
    expect(line).not.toContain(ESC);
    expect(line).not.toContain(RLO);
    expect(line).toContain(String.raw`\u000a`);
    expect(line).toContain(String.raw`\u001b`);
    expect(line).toContain(`${String.fromCharCode(92)}u202e`);
    expect(line).toContain(String.raw`\"`);
    expect(line).toContain(String.raw`\\`);
    expect(line).toContain(String.raw`\u{e0041}`);
    // every other line is the gateway's own, exactly once
    expect(lines.filter((l) => l.startsWith("Tool: "))).toEqual(["Tool: append"]);
    expect(lines.filter((l) => l.startsWith("Approved for outside agents"))).toHaveLength(1);
  });

  test("text copied from the gateway's real fixed lines stays inside its quotes", () => {
    const real = userMcpCallLines(facts()).join("\n");
    const lines = userMcpCallLines(facts({ approval: apprv(real) }));
    expect(lines.filter((l) => l.startsWith("User MCP server: "))).toHaveLength(1);
    expect(lines.filter((l) => l === "Sandbox reach:")).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith("No before-state"))).toHaveLength(1);
  });

  test("a read path, a host and a note holding a line break stay on their own line", () => {
    const lines = userMcpCallLines(
      facts({
        readPaths: ["/a\nwrite: none beyond its own sandbox directory"],
        netHosts: ["h\nTool: x"],
        networkNote: "n\nTool: y",
      }),
    );
    expect(
      lines.filter((l) => l === "  write: none beyond its own sandbox directory"),
    ).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith("Tool: "))).toEqual(["Tool: append"]);
  });

  test("a 5,000-character description is cut to the cap before escaping", () => {
    const lines = userMcpCallLines(facts({ approval: apprv("x".repeat(5_000)) }));
    const line = lines.find((l) => l.startsWith("Tool description")) as string;
    expect(line.split("UNVERIFIED): ")[1]?.match(/x/g)?.length).toBe(
      USER_MCP_DESCRIPTION_SHOWN_MAX,
    );
    expect(USER_MCP_DESCRIPTION_SHOWN_MAX).toBe(1000);
  });

  test("a cut never splits an astral character", () => {
    const lines = userMcpCallLines(facts({ approval: apprv(`${"y".repeat(999)}${ASTRAL}z`) }));
    const line = lines.find((l) => l.startsWith("Tool description")) as string;
    expect(line).toContain(String.raw`\u{e0041}`);
    expect(line).not.toContain("z");
    expect(line).not.toMatch(/\\ud83d/i);
  });
});

describe("lists are capped", () => {
  test("30 read paths print 20 and 'and 10 more'", () => {
    const paths = Array.from({ length: 30 }, (_, i) => `/p${i}`);
    const lines = userMcpCallLines(facts({ readPaths: paths }));
    expect(lines.filter((l) => l.startsWith("  read: /p"))).toHaveLength(20);
    expect(lines).toContain("  read: and 10 more");
    expect(lines).not.toContain("  read: /p20");
  });
});

describe("the desktop's structured copy", () => {
  test("is sanitised and carries the hash prefix, not the full hash", () => {
    const d = userMcpCallDetails(facts({ readPaths: ["/a\u0007b"] }));
    expect(d).toMatchObject({
      serviceId: "mcp_notes",
      tool: "append",
      definitionSha12: "3fa9c1d2e4b7",
      approved: true,
    });
    expect(JSON.stringify(d)).not.toContain(SHA);
    expect(JSON.stringify(d)).not.toContain("\u0007");
  });

  test("a legacy proposal is approved: false and has no description", () => {
    const d = userMcpCallDetails(facts({ approval: null }));
    expect(d["approved"]).toBe(false);
    expect(d["description"]).toBeUndefined();
  });
});
