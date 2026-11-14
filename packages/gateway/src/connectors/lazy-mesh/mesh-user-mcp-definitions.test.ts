/**
 * listUserMcpToolDefinitions (AD5a Task 2): ONE registered user-MCP server's tool definitions,
 * STRIPPED to `description` and `inputSchema`. The listing's own `execute` would call the sandboxed
 * server past the executor's gate, so it is never handed out from here.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MCPClient } from "@mastra/mcp";
import type { PlatformPaths } from "../../platform/paths.ts";
import { createMockVault } from "../../vault/mock.ts";
import { LazyDrainTracker } from "./drain.ts";
import { userMcpMeshKey } from "./keys.ts";
import { LazyConnectorMesh } from "./mesh.ts";
import type { LazyMcpSlot } from "./slot.ts";

const roots: string[] = [];
let mesh: LazyConnectorMesh | undefined;

function makePaths(): PlatformPaths {
  const root = mkdtempSync(join(tmpdir(), "nimbus-mesh-umd-"));
  roots.push(root);
  return {
    configDir: join(root, "config"),
    dataDir: join(root, "data"),
    logDir: join(root, "log"),
    socketPath: join(root, "sock"),
    extensionsDir: join(root, "ext"),
    tempDir: join(root, "tmp"),
    sandboxDir: join(root, "sandbox"),
  };
}

afterEach(async () => {
  if (mesh !== undefined) await mesh.disconnect().catch(() => undefined);
  mesh = undefined;
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function userRow(serviceId: string) {
  return {
    service_id: serviceId,
    command: "/bin/echo",
    args_json: "[]",
    created_at: 0,
    read_paths_json: "[]",
    net_hosts_json: "[]",
    model_access: 0,
  };
}

type Fake = { client: MCPClient; calls: () => number };

function fakeClient(tools: Record<string, unknown> | "throw"): Fake {
  let calls = 0;
  const client = {
    listTools: async () => {
      calls += 1;
      if (tools === "throw") throw new Error("synthetic listing failure");
      return tools;
    },
    disconnect: async () => undefined,
  };
  return { client: client as unknown as MCPClient, calls: () => calls };
}

function install(m: LazyConnectorMesh, serviceId: string, fake: Fake): void {
  (m as unknown as { lazySlots: Map<string, LazyMcpSlot> }).lazySlots.set(
    userMcpMeshKey(serviceId),
    { client: fake.client, idleTimer: undefined, drain: new LazyDrainTracker() },
  );
}

const SCHEMA = { type: "object", properties: { text: { type: "string" } } };

describe("listUserMcpToolDefinitions", () => {
  test("an unregistered id returns undefined and lists nothing", async () => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      listUserMcpConnectors: () => [],
    });
    expect(await mesh.listUserMcpToolDefinitions("mcp_missing")).toBeUndefined();
  });

  test("each entry has exactly the keys description and inputSchema: the listing's execute (and anything else) never leaves", async () => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      listUserMcpConnectors: () => [userRow("mcp_a")],
    });
    const fake = fakeClient({
      mcp_a_echo: {
        description: "echoes",
        inputSchema: SCHEMA,
        execute: async () => "called the server",
        outputSchema: { type: "object" },
        requireApproval: false,
        mcp: { annotations: { destructiveHint: true } },
      },
    });
    install(mesh, "mcp_a", fake);
    const out = await mesh.listUserMcpToolDefinitions("mcp_a");
    expect(Object.keys(out ?? {})).toEqual(["mcp_a_echo"]);
    const e = out?.["mcp_a_echo"] as Record<string, unknown>;
    expect(Object.keys(e).sort((a, b) => a.localeCompare(b))).toEqual([
      "description",
      "inputSchema",
    ]);
    expect(e["description"]).toBe("echoes");
    expect(e["inputSchema"]).toBe(SCHEMA);
    expect("execute" in e).toBe(false);
  });

  test("a description that is absent or not a string is passed through untouched (the hash decides)", async () => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      listUserMcpConnectors: () => [userRow("mcp_a")],
    });
    install(
      mesh,
      "mcp_a",
      fakeClient({
        mcp_a_none: { inputSchema: SCHEMA },
        mcp_a_nul: { description: null, inputSchema: SCHEMA },
        mcp_a_num: { description: 5, inputSchema: SCHEMA },
      }),
    );
    const out = (await mesh.listUserMcpToolDefinitions("mcp_a")) as Record<
      string,
      Record<string, unknown>
    >;
    expect(out["mcp_a_none"]?.["description"]).toBeUndefined();
    expect(out["mcp_a_nul"]?.["description"]).toBeNull();
    expect(out["mcp_a_num"]?.["description"]).toBe(5);
  });

  test("only that server's slot is listed; another registered server's slot is never touched", async () => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      listUserMcpConnectors: () => [userRow("mcp_a"), userRow("mcp_b")],
    });
    const a = fakeClient({ mcp_a_x: { description: "a", inputSchema: SCHEMA } });
    const b = fakeClient({ mcp_b_x: { description: "b", inputSchema: SCHEMA } });
    install(mesh, "mcp_a", a);
    install(mesh, "mcp_b", b);
    await mesh.listUserMcpToolDefinitions("mcp_a");
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(0);
  });

  test("a key that does not start with <serviceId>_ is dropped, so a prefix-sharing server cannot lend a definition", async () => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      listUserMcpConnectors: () => [userRow("mcp_a")],
    });
    install(
      mesh,
      "mcp_a",
      fakeClient({
        mcp_a_ok: { description: "mine", inputSchema: SCHEMA },
        mcp_ab_other: { description: "foreign", inputSchema: SCHEMA },
        github_issue_create: { description: "first-party", inputSchema: SCHEMA },
      }),
    );
    const out = await mesh.listUserMcpToolDefinitions("mcp_a");
    expect(Object.keys(out ?? {})).toEqual(["mcp_a_ok"]);
  });

  test("a server that lists no tool (it failed to start: the client swallows that and lists nothing) is undefined, not an empty map", async () => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      listUserMcpConnectors: () => [userRow("mcp_a")],
    });
    install(mesh, "mcp_a", fakeClient({}));
    expect(await mesh.listUserMcpToolDefinitions("mcp_a")).toBeUndefined();
  });

  test("a listing that throws rejects (the door reads that as 'cannot be listed now')", async () => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      listUserMcpConnectors: () => [userRow("mcp_a")],
    });
    install(mesh, "mcp_a", fakeClient("throw"));
    await expect(mesh.listUserMcpToolDefinitions("mcp_a")).rejects.toThrow("synthetic");
  });

  test("an entry that is not an object is kept as an entry with nothing readable, never as the raw value", async () => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      listUserMcpConnectors: () => [userRow("mcp_a")],
    });
    install(mesh, "mcp_a", fakeClient({ mcp_a_odd: "a string", mcp_a_nil: null }));
    const out = (await mesh.listUserMcpToolDefinitions("mcp_a")) as Record<string, unknown>;
    expect(out["mcp_a_odd"]).toEqual({ description: undefined, inputSchema: undefined });
    expect(out["mcp_a_nil"]).toEqual({ description: undefined, inputSchema: undefined });
  });
});

describe("listUserMcpToolDefinitions deadline (agent door review, finding 1)", () => {
  /** A client whose listing never settles until released. */
  function hangingClient(): { client: MCPClient; release: () => void } {
    let release: () => void = () => undefined;
    const client = {
      listTools: () =>
        new Promise<Record<string, unknown>>((resolve) => {
          release = () => resolve({ mcp_a_x: { description: "late", inputSchema: SCHEMA } });
        }),
      disconnect: async () => undefined,
    };
    return { client: client as unknown as MCPClient, release: () => release() };
  }

  test("a listing that never settles resolves as undefined within the deadline, and a later normal listing works", async () => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      listUserMcpConnectors: () => [userRow("mcp_a")],
      userMcpListingDeadlineMs: 25,
    });
    const hang = hangingClient();
    install(mesh, "mcp_a", { client: hang.client, calls: () => 0 });
    const started = Date.now();
    expect(await mesh.listUserMcpToolDefinitions("mcp_a")).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2000);
    // The abandoned promise settling later is harmless (no unhandled rejection, no effect).
    hang.release();
    install(mesh, "mcp_a", fakeClient({ mcp_a_x: { description: "fresh", inputSchema: SCHEMA } }));
    const again = await mesh.listUserMcpToolDefinitions("mcp_a");
    expect(Object.keys(again ?? {})).toEqual(["mcp_a_x"]);
  });

  test("a listing that settles inside the deadline is returned as before", async () => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      listUserMcpConnectors: () => [userRow("mcp_a")],
      userMcpListingDeadlineMs: 5000,
    });
    install(mesh, "mcp_a", fakeClient({ mcp_a_x: { description: "d", inputSchema: SCHEMA } }));
    expect(Object.keys((await mesh.listUserMcpToolDefinitions("mcp_a")) ?? {})).toEqual([
      "mcp_a_x",
    ]);
  });
});
