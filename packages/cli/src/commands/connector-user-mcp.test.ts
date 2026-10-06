import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  runConnectorAddMcp,
  runConnectorCall,
  runConnectorTools,
  type UserMcpCallOutcome,
  type UserMcpDeps,
} from "./connector-user-mcp.ts";

type Sent = { method: string; params: unknown };

function makeDeps(
  respond: (method: string, params: unknown) => unknown,
  sent: Sent[],
  out: string[],
  err: string[],
): UserMcpDeps {
  return {
    call: async (method, params) => {
      sent.push({ method, params });
      return respond(method, params);
    },
    log: (l) => out.push(l),
    error: (l) => err.push(l),
  };
}

describe("connector tools / call", () => {
  let sent: Sent[];
  let out: string[];
  let err: string[];
  beforeEach(() => {
    sent = [];
    out = [];
    err = [];
    process.exitCode = 0;
  });
  afterEach(() => {
    process.exitCode = 0;
  });

  const toolsResp = {
    serviceId: "mcp_x",
    tools: [{ name: "echo", description: "Echo text", inputSchema: {} }],
  };

  test("tools prints one line per tool", async () => {
    await runConnectorTools(
      ["mcp_x"],
      makeDeps(() => toolsResp, sent, out, err),
    );
    expect(sent).toEqual([{ method: "connector.userMcpTools", params: { serviceId: "mcp_x" } }]);
    expect(out).toEqual(["echo — Echo text"]);
  });

  test("tools --json prints raw response", async () => {
    await runConnectorTools(
      ["mcp_x", "--json"],
      makeDeps(() => toolsResp, sent, out, err),
    );
    expect(JSON.parse(out.join("\n"))).toEqual(toolsResp);
  });

  test("tools without id is a usage error", async () => {
    await runConnectorTools(
      [],
      makeDeps(() => toolsResp, sent, out, err),
    );
    expect(sent).toHaveLength(0);
    expect(process.exitCode).toBe(1);
  });

  test("tools not registered exits 2", async () => {
    const deps = makeDeps(
      () => {
        throw new Error("ERR_USER_MCP_NOT_REGISTERED: mcp_x");
      },
      sent,
      out,
      err,
    );
    await runConnectorTools(["mcp_x"], deps);
    expect(process.exitCode).toBe(2);
    expect(err.join("\n")).toContain("ERR_USER_MCP_NOT_REGISTERED");
  });

  test("call sends input and prints joined text content", async () => {
    const res: UserMcpCallOutcome = {
      status: "ok",
      result: {
        content: [
          { type: "text", text: "hi" },
          { type: "text", text: "there" },
        ],
      },
    };
    await runConnectorCall(
      ["mcp_x", "echo", "--input", '{"text":"hi"}'],
      makeDeps(() => res, sent, out, err),
    );
    expect(sent).toEqual([
      {
        method: "connector.userMcpCall",
        params: { serviceId: "mcp_x", tool: "echo", input: { text: "hi" } },
      },
    ]);
    expect(out).toEqual(["hi\nthere"]);
    expect(process.exitCode).toBe(0);
  });

  test("call falls back to JSON.stringify for non-content results", async () => {
    await runConnectorCall(
      ["mcp_x", "echo"],
      makeDeps(() => ({ status: "ok", result: { a: 1 } }), sent, out, err),
    );
    expect(out).toEqual(['{"a":1}']);
    expect((sent[0] as { params: { input?: unknown } }).params.input).toBeUndefined();
  });

  test("call --json prints raw outcome", async () => {
    const res = { status: "ok", result: { a: 1 } };
    await runConnectorCall(
      ["mcp_x", "echo", "--json"],
      makeDeps(() => res, sent, out, err),
    );
    expect(JSON.parse(out.join("\n"))).toEqual(res);
  });

  test.each(["[1]", "not json", '"s"', "null"])(
    "bad --input %s sends nothing, exit 1",
    async (bad) => {
      await runConnectorCall(
        ["mcp_x", "echo", "--input", bad],
        makeDeps(() => ({}), sent, out, err),
      );
      expect(sent).toHaveLength(0);
      expect(process.exitCode).toBe(1);
    },
  );

  test("rejected exits 2 with Refused line", async () => {
    await runConnectorCall(
      ["mcp_x", "echo"],
      makeDeps(() => ({ status: "rejected", reason: "denied" }), sent, out, err),
    );
    expect(process.exitCode).toBe(2);
    expect(`${out.join("\n")}${err.join("\n")}`).toContain("Refused: denied");
  });

  test("unknown tool error exits 2", async () => {
    await runConnectorCall(
      ["mcp_x", "nope"],
      makeDeps(
        () => {
          throw new Error("ERR_USER_MCP_UNKNOWN_TOOL: nope");
        },
        sent,
        out,
        err,
      ),
    );
    expect(process.exitCode).toBe(2);
  });

  test("tool error exits 1", async () => {
    await runConnectorCall(
      ["mcp_x", "echo"],
      makeDeps(
        () => {
          throw new Error("tool blew up");
        },
        sent,
        out,
        err,
      ),
    );
    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain("tool blew up");
  });
});

describe("connector add --mcp — the owner decides", () => {
  let sent: Sent[];
  let out: string[];
  let err: string[];
  beforeEach(() => {
    sent = [];
    out = [];
    err = [];
    process.exitCode = 0;
  });
  afterEach(() => {
    process.exitCode = 0;
  });

  const tail = ["mcp_x", "--read", "notes", "--net", "api.example.com", "--", "npx", "-y", "pkg"];

  test("a denied prompt prints Refused, no grant lines, and exits 2", async () => {
    await runConnectorAddMcp(
      tail,
      makeDeps(() => ({ status: "rejected", reason: "owner denied" }), sent, out, err),
      "/work",
    );
    expect(sent.map((s) => s.method)).toEqual(["connector.addMcp"]);
    expect(out).toEqual(["Refused: owner denied"]);
    const printed = out.join(" | ");
    expect(printed).not.toContain("Registered");
    expect(printed).not.toContain("read:");
    expect(printed).not.toContain("net:");
    expect(process.exitCode).toBe(2);
  });

  test("an approved registration prints the id and every grant, exit 0", async () => {
    await runConnectorAddMcp(
      tail,
      makeDeps(() => ({ ok: true, serviceId: "mcp_x" }), sent, out, err),
      "/work",
    );
    expect(out[0]).toBe("Registered user MCP connector: mcp_x");
    expect(out.some((l) => l.startsWith("  read: "))).toBe(true);
    expect(out).toContain("  net:  api.example.com");
    expect(process.exitCode).toBe(0);
  });
});
