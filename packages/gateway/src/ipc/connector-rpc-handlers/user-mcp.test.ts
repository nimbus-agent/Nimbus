import { describe, expect, test } from "bun:test";
import type { LazyConnectorMesh } from "../../connectors/lazy-mesh/index.ts";
import type { LazyMeshToolMap } from "../../connectors/lazy-mesh/tool-map.ts";
import type { ToolExecutor } from "../../engine/executor.ts";
import type { PlannedAction } from "../../engine/types.ts";
import { ExtensionRunGrantError } from "../../extensions/run-grant-error.ts";
import { ConnectorRpcError } from "../connector-rpc-shared.ts";
import { handleConnectorUserMcpCall, handleConnectorUserMcpTools } from "./user-mcp.ts";

function meshWith(list: (id: string) => Promise<LazyMeshToolMap | undefined>): LazyConnectorMesh {
  return { listOwnerCodeServerTools: list } as unknown as LazyConnectorMesh;
}

const extTools = {
  ext_foo_echo: { description: "Echo", inputSchema: { type: "object" } },
} as unknown as LazyMeshToolMap;

function recordingExecutor(seen: PlannedAction[]): ToolExecutor {
  return {
    execute: async (a: PlannedAction) => {
      seen.push(a);
      return { status: "ok", result: "done" };
    },
  } as unknown as ToolExecutor;
}

describe("owner code server (ext_) over connector.userMcp*", () => {
  test("tools lists an ext_ id with the prefix stripped, normalising case", async () => {
    const asked: string[] = [];
    const mesh = meshWith(async (id) => {
      asked.push(id);
      return extTools;
    });
    const res = await handleConnectorUserMcpTools(mesh, { serviceId: "EXT_FOO" });
    expect(asked).toEqual(["ext_foo"]);
    expect(res.serviceId).toBe("ext_foo");
    expect(res.tools.map((t) => t.name)).toEqual(["echo"]);
  });

  test("call executes ext_foo.echo with the derived mcpToolId", async () => {
    const seen: PlannedAction[] = [];
    await handleConnectorUserMcpCall(
      meshWith(async () => extTools),
      recordingExecutor(seen),
      { serviceId: "ext_foo", tool: "echo", input: { a: 1 } },
    );
    expect(seen).toEqual([
      { type: "ext_foo.echo", payload: { mcpToolId: "ext_foo_echo", input: { a: 1 } } },
    ]);
  });

  test("a grant refusal surfaces -32602 with its code and never reaches the executor", async () => {
    const seen: PlannedAction[] = [];
    const mesh = meshWith(async () => {
      throw new ExtensionRunGrantError("ERR_EXTENSION_RUN_TREE_CHANGED", "tree changed");
    });
    const err = await handleConnectorUserMcpCall(mesh, recordingExecutor(seen), {
      serviceId: "ext_foo",
      tool: "echo",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorRpcError);
    expect((err as ConnectorRpcError).rpcCode).toBe(-32602);
    expect((err as Error).message).toContain("ERR_EXTENSION_RUN_TREE_CHANGED");
    expect(seen).toEqual([]);
  });

  test("an unapproved ext_ id is not-registered and names both fixes", async () => {
    const err = await handleConnectorUserMcpTools(
      meshWith(async () => undefined),
      { serviceId: "ext_foo" },
    ).catch((e: unknown) => e);
    const msg = (err as Error).message;
    expect(msg).toContain("ERR_USER_MCP_NOT_REGISTERED");
    expect(msg).toContain("nimbus connector add --mcp");
    expect(msg).toContain("nimbus extension approve");
  });

  test("reserved tool absent from listTools and refused by connector call", async () => {
    const seen: PlannedAction[] = [];
    let listed = 0;
    // The mesh already filters the reserved tool out of the listing; the call is refused on the
    // NAME alone, before the mesh is even asked and before any consent prompt.
    const mesh = meshWith(async () => {
      listed += 1;
      return extTools;
    });
    // Listing is filtered in the mesh slot (covered in mesh-extension-slot.test.ts); here the
    // refusal must hold on the NAME even if a mesh listed the reserved tool.
    const leaky = meshWith(async () => ({
      ...extTools,
      ext_foo___nimbus_sync: { execute: async () => null },
    }));
    const leakyErr = await handleConnectorUserMcpCall(leaky, recordingExecutor(seen), {
      serviceId: "ext_foo",
      tool: "__nimbus_sync",
    }).catch((e: unknown) => e);
    expect((leakyErr as ConnectorRpcError).message).toContain("ERR_EXTENSION_RESERVED_TOOL");
    expect(seen).toEqual([]);
    const err = await handleConnectorUserMcpCall(mesh, recordingExecutor(seen), {
      serviceId: "ext_foo",
      tool: "__nimbus_sync",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorRpcError);
    expect((err as ConnectorRpcError).message).toContain("ERR_EXTENSION_RESERVED_TOOL");
    expect(listed).toBe(0);
    expect(seen).toEqual([]);
  });

  test("an unknown tool on an ext_ id is refused before the executor", async () => {
    const seen: PlannedAction[] = [];
    const err = await handleConnectorUserMcpCall(
      meshWith(async () => extTools),
      recordingExecutor(seen),
      { serviceId: "ext_foo", tool: "nope" },
    ).catch((e: unknown) => e);
    expect((err as Error).message).toContain("ERR_USER_MCP_UNKNOWN_TOOL");
    expect(seen).toEqual([]);
  });
});
