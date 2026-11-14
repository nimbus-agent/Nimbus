// Phase 28 AD5a: `nimbus connector writes ... mcp_<id> --door agent` (the owner's approval, by exact
// tool name, of a user MCP server's tools for outside agents) and the status section for such servers.
// The fake `call` seam records the method, the params and the call options.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { type ConnectorWritesDeps, runConnectorWrites } from "./connector-writes-cli.ts";

function harness(reply: unknown) {
  const calls: Array<{
    method: string;
    params?: Record<string, unknown> | undefined;
    opts?: unknown;
  }> = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const deps: ConnectorWritesDeps = {
    call: async (method, params, opts) => {
      calls.push({ method, params, opts });
      if (reply instanceof Error) throw reply;
      return reply;
    },
    log: (l) => logs.push(l),
    error: (l) => errors.push(l),
  };
  return { deps, calls, logs, errors };
}

let savedExit: typeof process.exitCode;
beforeEach(() => {
  savedExit = process.exitCode;
  process.exitCode = 0;
});
afterEach(() => {
  process.exitCode = savedExit;
});

const ESC = String.fromCodePoint(0x1b);

describe("connector writes enable mcp_<id> --door agent", () => {
  it("sends service, door and the exact names, as the person-only connection, and prints the record", async () => {
    const h = harness({
      service: "mcp_notes",
      door: "agent",
      listOnly: false,
      approved: 2,
      writes: [
        { toolId: "append", sha12: "3fa9c1d2e4b7" },
        { toolId: "search", sha12: "0123456789ab" },
      ],
    });
    await runConnectorWrites(
      ["enable", "mcp_notes", "--door", "agent", "--approve", "append", "--approve", "search"],
      h.deps,
    );
    expect(h.calls).toEqual([
      {
        method: "connector.writesEnable",
        params: { service: "mcp_notes", door: "agent", approve: ["append", "search"] },
        opts: { agentDoor: true },
      },
    ]);
    expect(h.logs).toEqual([
      "Approved: 2 tools approved for outside agents on mcp_notes.",
      "  append  3fa9c1d2e4b7",
      "  search  0123456789ab",
      "Each call an agent proposes still asks you and shows its exact input. A tool whose listed definition changes is suspended until you approve it again by name. The hash covers what the server lists, not what its code does.",
    ]);
    expect(process.exitCode).toBe(0);
  });

  it("with no --approve it prints each tool with its state and hash prefix, the command, and asks nothing", async () => {
    const h = harness({
      service: "mcp_notes",
      door: "agent",
      listOnly: true,
      approved: 0,
      writes: [],
      tools: [
        { toolId: "append", sha12: "3fa9c1d2e4b7", state: "will_be_approved" },
        { toolId: "search", sha12: "0123456789ab", state: "already_approved" },
        { toolId: "wipe", sha12: "ba9876543210", state: "reapproved_changed" },
      ],
      notApprovable: [`bad.name${ESC}[2J`],
    });
    await runConnectorWrites(["enable", "mcp_notes", "--door", "agent"], h.deps);
    expect(h.calls[0]?.params).toEqual({ service: "mcp_notes", door: "agent" });
    expect(h.logs).toEqual([
      "mcp_notes lists 3 tools. Nothing was asked and nothing was approved.",
      "  append  3fa9c1d2e4b7  not approved yet",
      "  search  0123456789ab  already approved",
      "  wipe    ba9876543210  approved before, definition changed (approving again replaces it)",
      "Not approvable (a name may use letters, digits, _ and - only): bad.name[2J",
      "To approve tools for outside agents, name each one:",
      "  nimbus connector writes enable mcp_notes --door agent --approve append --approve wipe",
    ]);
    expect(h.logs.join("\n")).not.toContain(ESC);
    expect(process.exitCode).toBe(0);
  });

  it("says how many listed tools were left out past the gateway's cap, and how to approve one anyway (agent door review, finding 5)", async () => {
    const h = harness({
      service: "mcp_notes",
      door: "agent",
      listOnly: true,
      approved: 0,
      writes: [],
      tools: [{ toolId: "append", sha12: "3fa9c1d2e4b7", state: "will_be_approved" }],
      omitted: 5,
    });
    await runConnectorWrites(["enable", "mcp_notes", "--door", "agent"], h.deps);
    expect(h.logs).toContain(
      "5 more tools are listed but not shown. A tool can still be approved by its exact name with --approve <tool>.",
    );
    const one = harness({
      service: "mcp_notes",
      door: "agent",
      listOnly: true,
      approved: 0,
      writes: [],
      tools: [],
      omitted: 1,
    });
    await runConnectorWrites(["enable", "mcp_notes", "--door", "agent"], one.deps);
    expect(one.logs.join("\n")).toContain("1 more tool is listed but not shown.");
  });

  it("says so when every listed tool is approved already, and when the server lists none", async () => {
    const all = harness({
      service: "mcp_notes",
      door: "agent",
      listOnly: true,
      approved: 0,
      writes: [],
      tools: [{ toolId: "append", sha12: "3fa9c1d2e4b7", state: "already_approved" }],
    });
    await runConnectorWrites(["enable", "mcp_notes", "--door", "agent"], all.deps);
    expect(all.logs).toEqual([
      "mcp_notes lists 1 tool. Nothing was asked and nothing was approved.",
      "  append  3fa9c1d2e4b7  already approved",
      "Every listed tool is approved for outside agents already.",
    ]);
    const none = harness({
      service: "mcp_notes",
      door: "agent",
      listOnly: true,
      approved: 0,
      writes: [],
      tools: [],
    });
    await runConnectorWrites(["enable", "mcp_notes", "--door", "agent"], none.deps);
    expect(none.logs).toEqual(["mcp_notes lists no tools that can be approved."]);
  });

  it("strips control characters from names and hashes the server or the reply supplied", async () => {
    const h = harness({
      service: "mcp_notes",
      door: "agent",
      listOnly: false,
      approved: 1,
      writes: [{ toolId: `ap${ESC}[2Jpend`, sha12: `3fa9${ESC}c1d2e4b7` }],
    });
    await runConnectorWrites(
      ["enable", "mcp_notes", "--door", "agent", "--approve", "append"],
      h.deps,
    );
    expect(h.logs.join("\n")).not.toContain(ESC);
    expect(h.logs[1]).toBe("  ap[2Jpend  3fa9c1d2e4b7");
  });

  const usageErrors: string[][] = [
    ["enable", "mcp_notes", "--door", "agent", "--wave", "3"],
    ["enable", "mcp_notes", "--door", "agent", "--workdir", "/a"],
    ["enable", "mcp_notes", "--door", "agent", "--grant", "ns@ctx"],
    ["enable", "mcp_notes", "--door", "agent", "--cloud", "aws"],
    ["enable", "mcp_notes"],
    ["enable", "mcp_notes", "--door", "model"],
    ["enable", "mcp_notes", "--door", "agent", "--approve"],
  ];
  for (const args of usageErrors) {
    it(`exits 2 with usage and no RPC for ${args.join(" ")}`, async () => {
      const h = harness({});
      await runConnectorWrites(args, h.deps);
      expect(h.calls).toEqual([]);
      expect(h.errors[0]).toContain("Usage:");
      expect(process.exitCode).toBe(2);
    });
  }

  it("a wave on a user MCP server says that such a server has no waves", async () => {
    const h = harness({});
    await runConnectorWrites(["enable", "mcp_notes", "--door", "agent", "--wave", "3"], h.deps);
    expect(h.errors.join("\n")).toContain("no waves");
  });

  const refusals: Array<[code: string, text: string]> = [
    ["ERR_CONNECTOR_WRITES_AGENT_CLIENT", "terminal or desktop"],
    ["ERR_CONNECTOR_WRITES_AGENT_USER_MCP_WAVE", "no waves"],
    ["ERR_CONNECTOR_WRITES_AGENT_SCOPE", "no directory"],
    ["ERR_CONNECTOR_WRITES_BAD_APPROVE", "exact tool names"],
    ["ERR_CONNECTOR_WRITES_UNKNOWN_SERVICE", "not registered"],
    ["ERR_CONNECTOR_WRITES_POLICY", "user_mcp_model_access"],
    ["ERR_CONNECTOR_WRITES_AGENT_UNLISTED", "could not be started"],
    ["ERR_CONNECTOR_WRITES_AGENT_NO_MATCH", "without --approve"],
    ["ERR_CONNECTOR_WRITES_DECLINED", "declined"],
    ["ERR_CONNECTOR_WRITES_AGENT_CHANGED", "removed or registered again"],
  ];
  for (const [code, text] of refusals) {
    it(`maps ${code} to one plain line and exit 2`, async () => {
      const h = harness(new Error(`${code}: whatever`));
      await runConnectorWrites(
        ["enable", "mcp_notes", "--door", "agent", "--approve", "append"],
        h.deps,
      );
      expect(h.errors).toHaveLength(1);
      expect(h.errors[0]).toContain(text);
      expect(process.exitCode).toBe(2);
    });
  }

  it("says a non-person answer cannot approve a user MCP tool", async () => {
    const h = harness(
      new Error(
        "ERR_CONNECTOR_WRITES_DECLINED: the approval did not come from a person at a terminal (--yes, a script and an old client cannot approve); nothing was enabled",
      ),
    );
    await runConnectorWrites(
      ["enable", "mcp_notes", "--door", "agent", "--approve", "append"],
      h.deps,
    );
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toContain("person");
  });

  it("a first-party service is unchanged: --wave is still accepted with --door agent", async () => {
    const h = harness({ service: "github", door: "agent", maxWave: 3, approved: 0, writes: [] });
    await runConnectorWrites(["enable", "github", "--door", "agent", "--wave", "3"], h.deps);
    expect(h.calls[0]?.params).toEqual({ service: "github", door: "agent", wave: 3 });
  });
});

describe("connector writes status: user MCP servers", () => {
  const status = {
    services: [{ service: "github", enabled: false, writes: 9, offerable: 0 }],
    policyAllows: true,
    agent: {
      policyAllows: true,
      checked: true,
      lockedOff: [],
      legacy: null,
      services: [
        {
          service: "mcp_notes",
          userMcp: true,
          approved: 3,
          suspended: [
            {
              toolId: `app${ESC}[2Jend`,
              approvedAt: Date.UTC(2026, 10, 13),
              approvedSha12: "0123456789ab",
              nowSha12: "ba9876543210",
            },
          ],
          notListed: ["old_tool"],
        },
        {
          service: "mcp_wiki",
          userMcp: true,
          approved: 1,
          suspended: [],
          unverified: "its tools could not be listed",
        },
      ],
    },
  };

  it("prints a section for user MCP servers with counts, suspended tools, not-listed tools and unverified", async () => {
    const h = harness(status);
    await runConnectorWrites(["status"], h.deps);
    expect(h.logs).toEqual([
      "github  off",
      "User MCP servers (outside agents):",
      "  mcp_notes: 3 approved",
      "    suspended: app[2Jend definition changed since approved 2026-11-13 (approved 0123456789ab, now ba9876543210)",
      "    not listed now: old_tool",
      "  mcp_wiki: 1 approved (unverified: its tools could not be listed)",
      "Policy: allows",
      "Agent policy: allows",
    ]);
    expect(h.logs.join("\n")).not.toContain(ESC);
  });

  it("does not print the section when no user MCP server has an approval", async () => {
    const h = harness({
      services: [],
      policyAllows: true,
      agent: { policyAllows: true, services: [] },
    });
    await runConnectorWrites(["status"], h.deps);
    expect(h.logs.join("\n")).not.toContain("User MCP servers");
  });

  it("names user_mcp_model_access when the organisation turned it off, even if connector writes are allowed", async () => {
    const h = harness({
      services: [],
      policyAllows: true,
      agent: { policyAllows: true, lockedOff: ["user_mcp_model_access"], services: [] },
    });
    await runConnectorWrites(["status"], h.deps);
    const line = h.logs.find((l) => l.startsWith("Agent policy:")) ?? "";
    expect(line).toContain("user_mcp_model_access");
    expect(line).toContain("user MCP");
  });

  it("the legacy block adds the user MCP command when a user MCP type was accepted", async () => {
    const h = harness({
      services: [],
      policyAllows: true,
      agent: {
        policyAllows: true,
        legacy: { sinceMs: 0, total: 2, byType: { "mcp_notes.append": 2 }, notice: "n" },
        services: [],
      },
    });
    await runConnectorWrites(["status"], h.deps);
    expect(h.logs).toContain(
      "For a user MCP tool run: nimbus connector writes enable mcp_<id> --door agent --approve <tool>",
    );
  });
});
