/**
 * The MCP adapter on `@nimbus-dev/sdk/mcp-server` (agent door AD6b): one server answers a client
 * of revision 2026-07-28 and a client that opens with `initialize`, lists the same tools to both,
 * and lists them exactly as the upstream MCP SDK 1.32.0 did before the adapter left it.
 *
 * `__fixtures__/upstream-1.32.0-tools-list.json` is what upstream answered to `tools/list` for
 * every tool the adapter can register, recorded with an upstream client over an in-memory
 * transport on the commit before the swap. It is a record, never regenerated: a tool added later
 * has no entry there and is checked by the "every tool is either recorded or listed as new" test.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type McpOutgoingMessage,
  type McpServer,
  META_CLIENT_CAPABILITIES,
  META_CLIENT_INFO,
  META_PROTOCOL_VERSION,
  MODERN_PROTOCOL_VERSION,
} from "@nimbus-dev/sdk/mcp-server";
import {
  type AdapterDeps,
  buildMcpServer,
  buildMcpServerForGateway,
  type IpcCallable,
  TOOL_SPECS,
  toInputSchema,
} from "./adapter.ts";
import { CAPTURE_TOOL_SPECS } from "./capture-tools.ts";

interface ListedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  execution?: unknown;
}

const RECORDED = JSON.parse(
  readFileSync(join(import.meta.dir, "__fixtures__", "upstream-1.32.0-tools-list.json"), "utf8"),
) as ListedTool[];

/** Tools added after the record was made. Each is listed here by name, on purpose. */
const ADDED_SINCE_THE_RECORD: readonly string[] = [];

const UNUSED_DEPS: AdapterDeps = {
  getClient: () => Promise.reject(new Error("tools/list reaches no gateway")),
};

type Reply = Extract<McpOutgoingMessage, { id: unknown }> & {
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: Record<string, unknown> };
};

/** A scripted client: sends one message and returns the server's answer to it. */
function scripted(server: McpServer) {
  const sent: McpOutgoingMessage[] = [];
  const connection = server.connect((m) => sent.push(m));
  let nextId = 1;
  return {
    async request(method: string, params?: Record<string, unknown>): Promise<Reply> {
      const id = nextId;
      nextId += 1;
      await connection.receive({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
      const reply = sent.find((m) => (m as { id?: unknown }).id === id);
      if (reply === undefined) throw new Error(`no answer to ${method}`);
      return reply as Reply;
    },
  };
}

const modernMeta = (clientName: string | undefined, version = MODERN_PROTOCOL_VERSION) => ({
  _meta: {
    [META_PROTOCOL_VERSION]: version,
    [META_CLIENT_CAPABILITIES]: {},
    ...(clientName === undefined ? {} : { [META_CLIENT_INFO]: { name: clientName, version: "1" } }),
  },
});

/** A gateway whose act door is open, recording what it is asked. */
function recordingGateway() {
  const calls: Array<[string, unknown]> = [];
  const client: IpcCallable = {
    call: async <T>(method: string, params?: unknown): Promise<T> => {
      calls.push([method, params]);
      if (method === "capture.status") {
        return { enabled: true, kinds: ["note", "action"], actionEnabled: true } as T;
      }
      if (method === "capture.submit") {
        return { id: "cap_7", state: "proposed", expiresAt: 1_900_000_000_000 } as T;
      }
      return { kind: "mcp" } as T;
    },
    disconnect: async () => {},
  };
  const submitted = (): unknown[] =>
    calls.filter(([m]) => m === "capture.submit").map(([, p]) => p);
  return { client, submitted };
}

const PROPOSAL = {
  actionType: "github.issue.comment.create",
  input: { owner: "o", repo: "r", issueNumber: 1, body: "hello" },
  summary: "Comment on the issue",
};

describe("tools/list equals what the upstream MCP SDK 1.32.0 listed", () => {
  const all = [...TOOL_SPECS, ...CAPTURE_TOOL_SPECS];

  test("every tool is either recorded or listed as new, and nothing recorded is gone", () => {
    const recorded = new Set(RECORDED.map((t) => t.name));
    const now = new Set(all.map((s) => s.name));
    expect(all.filter((s) => !recorded.has(s.name)).map((s) => s.name)).toEqual([
      ...ADDED_SINCE_THE_RECORD,
    ]);
    expect(RECORDED.filter((t) => !now.has(t.name)).map((t) => t.name)).toEqual([]);
    expect(RECORDED.length).toBeGreaterThanOrEqual(28);
  });

  test.each(RECORDED.map((t) => [t.name, t] as const))(
    "%s: the converted input schema is the recorded one",
    (name, recorded) => {
      const spec = all.find((s) => s.name === name);
      if (spec === undefined) throw new Error(`${name} is recorded and no longer registered`);
      // toEqual ignores member order, which is all that differs: upstream wrote `$schema` last.
      expect(toInputSchema(spec.schema)).toEqual(recorded.inputSchema);
      expect(recorded.inputSchema["$schema"]).toBe("http://json-schema.org/draft-07/schema#");
    },
  );

  test("a legacy client is listed the recorded tools: name, description, schema, annotations, in order", async () => {
    const client = scripted(buildMcpServer(UNUSED_DEPS, true, CAPTURE_TOOL_SPECS));
    await client.request("initialize", { protocolVersion: "2025-11-25", capabilities: {} });
    const listed = (await client.request("tools/list")).result?.["tools"] as ListedTool[];
    // `execution` is the one member not carried over: upstream added `taskSupport: "forbidden"` to
    // every tool, a statement about a tasks feature this server does not have in either era.
    const expected = RECORDED.filter((t) => !ADDED_SINCE_THE_RECORD.includes(t.name)).map(
      ({ execution: _execution, ...rest }) => rest,
    );
    expect(RECORDED.every((t) => t.execution !== undefined)).toBe(true);
    expect(listed).toEqual(expected);
  });
});

describe("one server, both eras", () => {
  test("a 2026-07-28 client and an initialize client are listed the same tools", async () => {
    const server = buildMcpServer(UNUSED_DEPS, true, CAPTURE_TOOL_SPECS);
    const modern = scripted(server);
    const discovered = await modern.request("server/discover", modernMeta("new-editor"));
    expect(discovered.result?.["supportedVersions"]).toContain(MODERN_PROTOCOL_VERSION);
    const modernList = (await modern.request("tools/list", modernMeta("new-editor"))).result;

    const legacy = scripted(server);
    const opened = await legacy.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "old-editor", version: "1" },
    });
    expect(opened.result?.["protocolVersion"]).toBe("2025-11-25");
    const legacyList = (await legacy.request("tools/list")).result;

    expect(modernList?.["tools"]).toEqual(legacyList?.["tools"]);
    expect(modernList?.["tools"]).toHaveLength(TOOL_SPECS.length + CAPTURE_TOOL_SPECS.length);
    // The owner can close the door mid-session, so a modern client may not cache the list.
    expect(modernList?.["ttlMs"]).toBe(0);
    expect(modernList?.["cacheScope"]).toBe("private");
    expect(legacyList?.["ttlMs"]).toBeUndefined();
  });

  test("both complete a propose_action, each labelled with the name its own era carries", async () => {
    const gateway = recordingGateway();
    const server = await buildMcpServerForGateway({ getClient: async () => gateway.client });

    const modern = scripted(server);
    const first = await modern.request("tools/call", {
      name: "propose_action",
      arguments: PROPOSAL,
      ...modernMeta("new-editor"),
    });
    expect(first.result?.["isError"]).toBeUndefined();
    expect(JSON.stringify(first.result?.["content"])).toContain("cap_7");
    expect(first.result?.["resultType"]).toBe("complete");

    const legacy = scripted(server);
    await legacy.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "old-editor", version: "1" },
    });
    const second = await legacy.request("tools/call", {
      name: "propose_action",
      arguments: PROPOSAL,
    });
    expect(second.result?.["isError"]).toBeUndefined();
    expect(JSON.stringify(second.result?.["content"])).toContain("cap_7");

    expect(gateway.submitted()).toEqual([
      { kind: "action", payload: PROPOSAL, clientLabel: "new-editor" },
      { kind: "action", payload: PROPOSAL, clientLabel: "old-editor" },
    ]);
  });

  test("the modern label is read per request: two clients' names never mix, and none is no label", async () => {
    const gateway = recordingGateway();
    const server = await buildMcpServerForGateway({ getClient: async () => gateway.client });
    const client = scripted(server);
    const call = (name: string | undefined) =>
      client.request("tools/call", {
        name: "capture_note",
        arguments: { title: "t", body: "b" },
        ...modernMeta(name),
      });
    await call("first");
    await call(undefined);
    await call("second");
    expect(
      gateway.submitted().map((p) => (p as { clientLabel?: string }).clientLabel ?? null),
    ).toEqual(["first", null, "second"]);
  });

  test("--agent overrides the client's name in both eras, and is sent as a kit label", async () => {
    const gateway = recordingGateway();
    const server = await buildMcpServerForGateway({
      getClient: async () => gateway.client,
      agentKit: "claude-code",
    });
    const modern = scripted(server);
    await modern.request("tools/call", {
      name: "propose_action",
      arguments: PROPOSAL,
      ...modernMeta("new-editor"),
    });
    const legacy = scripted(server);
    await legacy.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "old-editor", version: "1" },
    });
    await legacy.request("tools/call", { name: "propose_action", arguments: PROPOSAL });
    const kit = {
      kind: "action",
      payload: PROPOSAL,
      clientLabel: "claude-code",
      labelSource: "kit",
    };
    expect(gateway.submitted()).toEqual([kit, kit]);
  });

  test("a version the server does not serve is refused with -32022 and the versions it does", async () => {
    const server = buildMcpServer(UNUSED_DEPS);
    const modern = await scripted(server).request(
      "tools/list",
      modernMeta("new-editor", "2099-01-01"),
    );
    expect(modern.error?.code).toBe(-32022);
    expect(modern.error?.message).toBe("Unsupported protocol version");
    expect(modern.error?.data?.["supported"]).toContain(MODERN_PROTOCOL_VERSION);
    expect(modern.error?.data?.["supported"]).toContain("2025-11-25");
  });

  test("arguments the tool's shape rejects are a tool error in both eras, and reach no gateway", async () => {
    const gateway = recordingGateway();
    const server = await buildMcpServerForGateway({ getClient: async () => gateway.client });
    const bad = { name: "propose_action", arguments: { actionType: 7, input: {}, summary: "s" } };
    const modern = await scripted(server).request("tools/call", { ...bad, ...modernMeta("e") });
    const legacy = scripted(server);
    await legacy.request("initialize", { protocolVersion: "2025-11-25", capabilities: {} });
    const old = await legacy.request("tools/call", bad);
    for (const reply of [modern, old]) {
      expect(reply.result?.["isError"]).toBe(true);
      expect(JSON.stringify(reply.result?.["content"])).toContain(
        "Invalid arguments for tool propose_action",
      );
    }
    expect(gateway.submitted()).toEqual([]);
  });

  test("a member the shape does not name never reaches the tool", async () => {
    const gateway = recordingGateway();
    const server = await buildMcpServerForGateway({ getClient: async () => gateway.client });
    await scripted(server).request("tools/call", {
      name: "capture_note",
      arguments: { title: "t", body: "b", clientLabel: "forged", labelSource: "kit" },
      ...modernMeta("honest"),
    });
    expect(gateway.submitted()).toEqual([
      { kind: "note", payload: { title: "t", body: "b" }, clientLabel: "honest" },
    ]);
  });

  test("no tool asks the client for input: nothing but answers is ever sent", async () => {
    const gateway = recordingGateway();
    const server = await buildMcpServerForGateway({ getClient: async () => gateway.client });
    const sent: McpOutgoingMessage[] = [];
    const connection = server.connect((m) => sent.push(m));
    await connection.receive({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "propose_action", arguments: PROPOSAL, ...modernMeta("e") },
    });
    expect(sent).toHaveLength(1);
    expect("method" in (sent[0] as object)).toBe(false);
    expect((sent[0] as Reply).result?.["resultType"]).toBe("complete");
  });
});
