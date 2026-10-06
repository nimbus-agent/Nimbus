/**
 * `connector.userMcpTools` / `connector.userMcpCall` — list ONE owner-registered user MCP server's
 * tools, and call one of them through a DISPATCHING `ToolExecutor` (so the call carries the audit
 * row, the I29 egress row and the I42 owner prompt). The mesh and the executor are fakes injected
 * through the dispatcher's options (DI, never `mock.module`).
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import type { LazyConnectorMesh } from "../connectors/lazy-mesh/index.ts";
import type { LazyMeshToolMap } from "../connectors/lazy-mesh/tool-map.ts";
import type { ToolExecutor } from "../engine/executor.ts";
import { LocalIndex } from "../index/local-index.ts";
import { createMockVault } from "../vault/mock.ts";
import { ConnectorRpcError, dispatchConnectorRpc } from "./connector-rpc.ts";

let db: Database;
let localIndex: LocalIndex;

beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  localIndex = new LocalIndex(db);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
});

const run = async (): Promise<unknown> => "unused";

/** Tool map shape as `MCPClient.listTools()` returns it: `<serverKey>_<tool>` keys. */
const X_TOOLS: Record<string, unknown> = {
  mcp_x_probe: {
    description: "Probe the thing",
    inputSchema: z.object({ depth: z.number() }),
    execute: run,
  },
  mcp_x_echo: {
    description: "Echo text back",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    execute: run,
  },
};

function fakeMesh(registered: Record<string, Record<string, unknown>>): {
  mesh: LazyConnectorMesh;
  listed: string[];
} {
  const listed: string[] = [];
  const mesh = {
    async listUserMcpTools(serviceId: string): Promise<LazyMeshToolMap | undefined> {
      listed.push(serviceId);
      const tools = registered[serviceId];
      return tools === undefined ? undefined : (tools as LazyMeshToolMap);
    },
  } as unknown as LazyConnectorMesh;
  return { mesh, listed };
}

type ExecResult = { status: "ok"; result: unknown } | { status: "rejected"; reason: string };

function fakeExecutor(result: ExecResult): {
  exec: ToolExecutor;
  calls: Array<{ type: string; payload?: Record<string, unknown> }>;
} {
  const calls: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const exec = {
    async execute(action: { type: string; payload?: Record<string, unknown> }) {
      calls.push(action);
      return result;
    },
  } as unknown as ToolExecutor;
  return { exec, calls };
}

function opts(method: string, params: unknown, mesh: LazyConnectorMesh, exec?: ToolExecutor) {
  return {
    method,
    params,
    vault: createMockVault(),
    localIndex,
    openUrl: async (_u: string): Promise<void> => {},
    syncScheduler: undefined,
    connectorMesh: mesh,
    ...(exec === undefined ? {} : { userMcpExecutor: exec }),
  };
}

async function expectRpcError(p: Promise<unknown>, code: number, msg: RegExp): Promise<void> {
  try {
    await p;
    throw new Error("expected ConnectorRpcError");
  } catch (e) {
    expect(e).toBeInstanceOf(ConnectorRpcError);
    expect((e as ConnectorRpcError).rpcCode).toBe(code);
    expect((e as ConnectorRpcError).message).toMatch(msg);
  }
}

describe("connector.userMcpTools", () => {
  test("unknown id → -32602 ERR_USER_MCP_NOT_REGISTERED", async () => {
    const { mesh } = fakeMesh({ mcp_x: X_TOOLS });
    await expectRpcError(
      dispatchConnectorRpc(opts("connector.userMcpTools", { serviceId: "mcp_nope" }, mesh)),
      -32602,
      /ERR_USER_MCP_NOT_REGISTERED/,
    );
  });

  test("a non-user-MCP id → -32602 ERR_USER_MCP_NOT_REGISTERED without asking the mesh", async () => {
    const { mesh, listed } = fakeMesh({ mcp_x: X_TOOLS });
    await expectRpcError(
      dispatchConnectorRpc(opts("connector.userMcpTools", { serviceId: "github" }, mesh)),
      -32602,
      /ERR_USER_MCP_NOT_REGISTERED/,
    );
    expect(listed).toEqual([]);
  });

  test("registered id → sorted bare names, description and JSON-schema input", async () => {
    const { mesh, listed } = fakeMesh({ mcp_x: X_TOOLS });
    const out = await dispatchConnectorRpc(
      opts("connector.userMcpTools", { serviceId: "mcp_x" }, mesh),
    );
    expect(out.kind).toBe("hit");
    const value = (out as { kind: "hit"; value: unknown }).value as {
      serviceId: string;
      tools: Array<{ name: string; description: string; inputSchema: unknown }>;
    };
    expect(listed).toEqual(["mcp_x"]);
    expect(value.serviceId).toBe("mcp_x");
    expect(value.tools.map((t) => t.name)).toEqual(["echo", "probe"]);
    const echo = value.tools[0];
    const probe = value.tools[1];
    expect(echo?.description).toBe("Echo text back");
    expect(echo?.inputSchema).toEqual({
      type: "object",
      properties: { text: { type: "string" } },
    });
    expect(probe?.description).toBe("Probe the thing");
    const probeSchema = probe?.inputSchema as { type?: unknown; properties?: unknown };
    expect(probeSchema.type).toBe("object");
    expect(probeSchema.properties).toEqual({ depth: { type: "number" } });
  });

  test("a missing description / non-object schema render as '' / null", async () => {
    const { mesh } = fakeMesh({ mcp_x: { mcp_x_bare: { execute: run, inputSchema: "nope" } } });
    const out = await dispatchConnectorRpc(
      opts("connector.userMcpTools", { serviceId: "mcp_x" }, mesh),
    );
    const value = (out as { kind: "hit"; value: { tools: unknown[] } }).value;
    expect(value.tools).toEqual([{ name: "bare", description: "", inputSchema: null }]);
  });

  test("a zod-shaped schema that cannot be converted renders as null", async () => {
    const { mesh } = fakeMesh({
      mcp_x: { mcp_x_odd: { execute: run, description: "d", inputSchema: { _zod: {} } } },
    });
    const out = await dispatchConnectorRpc(
      opts("connector.userMcpTools", { serviceId: "mcp_x" }, mesh),
    );
    const value = (out as { kind: "hit"; value: { tools: unknown[] } }).value;
    expect(value.tools).toEqual([{ name: "odd", description: "d", inputSchema: null }]);
  });

  test("no connector mesh → -32603", async () => {
    await expectRpcError(
      dispatchConnectorRpc({
        method: "connector.userMcpTools",
        params: { serviceId: "mcp_x" },
        vault: createMockVault(),
        localIndex,
        openUrl: async () => {},
        syncScheduler: undefined,
      }),
      -32603,
      /mesh/,
    );
  });
});

describe("connector.userMcpCall", () => {
  test("unknown tool → -32602 ERR_USER_MCP_UNKNOWN_TOOL, executor never called", async () => {
    const { mesh } = fakeMesh({ mcp_x: X_TOOLS });
    const { exec, calls } = fakeExecutor({ status: "ok", result: "x" });
    await expectRpcError(
      dispatchConnectorRpc(
        opts("connector.userMcpCall", { serviceId: "mcp_x", tool: "missing" }, mesh, exec),
      ),
      -32602,
      /ERR_USER_MCP_UNKNOWN_TOOL/,
    );
    expect(calls).toHaveLength(0);
  });

  test("unregistered server → -32602 ERR_USER_MCP_NOT_REGISTERED, executor never called", async () => {
    const { mesh } = fakeMesh({});
    const { exec, calls } = fakeExecutor({ status: "ok", result: "x" });
    await expectRpcError(
      dispatchConnectorRpc(
        opts("connector.userMcpCall", { serviceId: "mcp_x", tool: "echo" }, mesh, exec),
      ),
      -32602,
      /ERR_USER_MCP_NOT_REGISTERED/,
    );
    expect(calls).toHaveLength(0);
  });

  test("valid call → execute once with the exact action; result returned verbatim", async () => {
    const { mesh } = fakeMesh({ mcp_x: X_TOOLS });
    const result: ExecResult = {
      status: "ok",
      result: { content: [{ type: "text", text: "hi" }] },
    };
    const { exec, calls } = fakeExecutor(result);
    const out = await dispatchConnectorRpc(
      opts(
        "connector.userMcpCall",
        { serviceId: "mcp_x", tool: "echo", input: { text: "hi" } },
        mesh,
        exec,
      ),
    );
    expect(calls).toEqual([
      { type: "mcp_x.echo", payload: { mcpToolId: "mcp_x_echo", input: { text: "hi" } } },
    ]);
    expect(out).toEqual({ kind: "hit", value: result });
  });

  test("a rejected gate is returned verbatim", async () => {
    const { mesh } = fakeMesh({ mcp_x: X_TOOLS });
    const result: ExecResult = { status: "rejected", reason: "owner denied" };
    const { exec } = fakeExecutor(result);
    const out = await dispatchConnectorRpc(
      opts("connector.userMcpCall", { serviceId: "mcp_x", tool: "echo" }, mesh, exec),
    );
    expect(out).toEqual({ kind: "hit", value: result });
  });

  test("omitted input defaults to {}", async () => {
    const { mesh } = fakeMesh({ mcp_x: X_TOOLS });
    const { exec, calls } = fakeExecutor({ status: "ok", result: null });
    await dispatchConnectorRpc(
      opts("connector.userMcpCall", { serviceId: "mcp_x", tool: "probe" }, mesh, exec),
    );
    expect(calls).toEqual([
      { type: "mcp_x.probe", payload: { mcpToolId: "mcp_x_probe", input: {} } },
    ]);
  });

  test.each([
    ["a string", "str"],
    ["an array", []],
    ["null", null],
  ])("input that is %s → -32602, executor never called", async (_label, input) => {
    const { mesh } = fakeMesh({ mcp_x: X_TOOLS });
    const { exec, calls } = fakeExecutor({ status: "ok", result: "x" });
    await expectRpcError(
      dispatchConnectorRpc(
        opts("connector.userMcpCall", { serviceId: "mcp_x", tool: "echo", input }, mesh, exec),
      ),
      -32602,
      /input/,
    );
    expect(calls).toHaveLength(0);
  });

  test("missing / empty tool name → -32602", async () => {
    const { mesh } = fakeMesh({ mcp_x: X_TOOLS });
    const { exec, calls } = fakeExecutor({ status: "ok", result: "x" });
    for (const params of [{ serviceId: "mcp_x" }, { serviceId: "mcp_x", tool: "" }]) {
      await expectRpcError(
        dispatchConnectorRpc(opts("connector.userMcpCall", params, mesh, exec)),
        -32602,
        /tool/,
      );
    }
    expect(calls).toHaveLength(0);
  });

  test("no userMcpExecutor → -32603", async () => {
    const { mesh } = fakeMesh({ mcp_x: X_TOOLS });
    await expectRpcError(
      dispatchConnectorRpc(
        opts("connector.userMcpCall", { serviceId: "mcp_x", tool: "echo" }, mesh),
      ),
      -32603,
      /userMcpExecutor/,
    );
  });
});
