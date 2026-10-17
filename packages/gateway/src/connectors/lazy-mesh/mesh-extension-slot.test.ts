/**
 * The `mesh:ext:<serviceId>` slot: an approved extension's lazily spawned MCP client, and the
 * `stopExtensionClient` hook that must actually stop it (disable / revoke / failed startup verify).
 *
 * No real child process is spawned here (a macOS `bun test --parallel` bug hangs on them): the
 * mesh's `createExtensionClient` seam hands back a fake client. The real spawn is proven by an e2e.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type MCPClient, MCPClient as RealMCPClient } from "@mastra/mcp";

import { ExtensionRunGrantError } from "../../extensions/run-grant-error.ts";
import { LocalIndex } from "../../index/local-index.ts";
import type { PlatformPaths } from "../../platform/paths.ts";
import { sandboxCwdFor } from "../../platform/sandbox/sandbox-cwd.ts";
import { createMockVault } from "../../vault/mock.ts";
import { getConnectorHealth } from "../health.ts";
import { defaultCreateExtensionClient } from "./extension-slot.ts";
import type { ExtensionSlotSource, PreparedExtensionSpawn } from "./extension-slot-source.ts";
import { EXT_MESH_PREFIX, extensionMeshKey } from "./keys.ts";
import { LazyConnectorMesh } from "./mesh.ts";
import type { LazyMcpSlot, ServerSpec } from "./slot.ts";

const SERVICE_ID = "ext_foo";
const EXTENSION_ID = "foo-ext";

const createdRoots: string[] = [];
const openDbs: Database[] = [];
let mesh: LazyConnectorMesh | undefined;

function makePaths(): PlatformPaths {
  const root = mkdtempSync(join(tmpdir(), "nimbus-mesh-ext-"));
  createdRoots.push(root);
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
  if (mesh !== undefined) {
    await mesh.disconnect();
    mesh = undefined;
  }
  for (const db of openDbs.splice(0)) db.close();
  for (const root of createdRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

type FakeTools = Record<string, { execute?: (i: unknown, c?: unknown) => Promise<unknown> }>;

interface FakeClient {
  readonly id: string;
  readonly servers: Record<string, ServerSpec>;
  listTools(): Promise<FakeTools>;
  disconnect(): Promise<void>;
  disconnectCalls: number;
}

/** A fake source plus a recording client factory. */
function harness(opts: { listed?: () => readonly string[]; prepare?: () => Promise<void> } = {}) {
  let prepareCalls = 0;
  const clients: FakeClient[] = [];
  let listed: readonly string[] = [SERVICE_ID];
  const source: ExtensionSlotSource = {
    listServiceIds: () => (opts.listed === undefined ? listed : opts.listed()),
    async prepareSpawn(serviceId: string): Promise<PreparedExtensionSpawn> {
      prepareCalls += 1;
      await (opts.prepare?.() ?? Promise.resolve());
      return {
        extensionId: EXTENSION_ID,
        serviceId,
        spec: { command: "echo-server", args: [], env: {} },
      };
    },
  };
  const createExtensionClient = (id: string, servers: Record<string, ServerSpec>): MCPClient => {
    const serverKey = Object.keys(servers)[0] ?? "";
    const client: FakeClient = {
      id,
      servers,
      listTools: (): Promise<FakeTools> =>
        Promise.resolve({
          [`${serverKey}_echo`]: { execute: (): Promise<unknown> => Promise.resolve("echo") },
        }),
      disconnect(): Promise<void> {
        client.disconnectCalls += 1;
        return Promise.resolve();
      },
      disconnectCalls: 0,
    };
    clients.push(client);
    return client as unknown as MCPClient;
  };
  return {
    source,
    createExtensionClient,
    clients,
    get prepareCalls(): number {
      return prepareCalls;
    },
    setListed(ids: readonly string[]): void {
      listed = ids;
    },
  };
}

function slots(m: LazyConnectorMesh): Map<string, LazyMcpSlot> {
  return (m as unknown as { lazySlots: Map<string, LazyMcpSlot> }).lazySlots;
}

describe("mesh:ext: slot", () => {
  test("keys", () => {
    expect(EXT_MESH_PREFIX).toBe("mesh:ext:");
    expect(extensionMeshKey(SERVICE_ID)).toBe("mesh:ext:ext_foo");
  });

  test("no source, or an id the source does not list → undefined, nothing prepared", async () => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault());
    expect(await mesh.listExtensionTools(SERVICE_ID)).toBeUndefined();
    await mesh.disconnect();
    const h = harness();
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      extensionSlots: h.source,
      createExtensionClient: h.createExtensionClient,
    });
    expect(await mesh.listExtensionTools("ext_other")).toBeUndefined();
    expect(h.prepareCalls).toBe(0);
  });

  test("first list prepares once; a second within the idle window does not re-prepare", async () => {
    const h = harness();
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      extensionSlots: h.source,
      createExtensionClient: h.createExtensionClient,
    });
    const tools = await mesh.listExtensionTools(SERVICE_ID);
    expect(Object.keys(tools ?? {})).toEqual(["ext_foo_echo"]);
    expect(h.prepareCalls).toBe(1);
    expect(Object.keys(h.clients[0]?.servers ?? {})).toEqual([SERVICE_ID]);
    expect(mesh.isExtensionRunning(EXTENSION_ID)).toBe(true);

    await mesh.listExtensionTools(SERVICE_ID);
    expect(h.prepareCalls).toBe(1);
    expect(h.clients).toHaveLength(1);
  });

  test("concurrent lists with no live client share ONE prepareSpawn", async () => {
    const h = harness();
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      extensionSlots: h.source,
      createExtensionClient: h.createExtensionClient,
    });
    const [a, b] = await Promise.all([
      mesh.listExtensionTools(SERVICE_ID),
      mesh.listExtensionTools(SERVICE_ID),
    ]);
    expect(Object.keys(a ?? {})).toEqual(["ext_foo_echo"]);
    expect(Object.keys(b ?? {})).toEqual(["ext_foo_echo"]);
    expect(h.prepareCalls).toBe(1);
    expect(h.clients).toHaveLength(1);
  });

  test("stopExtensionClient stops the slot; the next list re-prepares (re-verification per spawn)", async () => {
    const h = harness();
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      extensionSlots: h.source,
      createExtensionClient: h.createExtensionClient,
    });
    await mesh.listExtensionTools(SERVICE_ID);
    await mesh.stopExtensionClient(EXTENSION_ID);
    expect(h.clients[0]?.disconnectCalls).toBe(1);
    expect(slots(mesh).has(extensionMeshKey(SERVICE_ID))).toBe(false);
    expect(mesh.isExtensionRunning(EXTENSION_ID)).toBe(false);

    await mesh.listExtensionTools(SERVICE_ID);
    expect(h.prepareCalls).toBe(2);
    expect(h.clients).toHaveLength(2);
  });

  test("stopExtensionClient still stops the slot after the source stops listing the id (grant deleted)", async () => {
    const h = harness();
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      extensionSlots: h.source,
      createExtensionClient: h.createExtensionClient,
    });
    await mesh.listExtensionTools(SERVICE_ID);
    h.setListed([]);
    await mesh.stopExtensionClient(EXTENSION_ID);
    expect(h.clients[0]?.disconnectCalls).toBe(1);
    expect(mesh.isExtensionRunning(EXTENSION_ID)).toBe(false);
  });

  test("idle-timer expiry disconnects and clears the running record", async () => {
    const h = harness();
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      inactivityMs: 5,
      extensionSlots: h.source,
      createExtensionClient: h.createExtensionClient,
    });
    await mesh.listExtensionTools(SERVICE_ID);
    expect(mesh.isExtensionRunning(EXTENSION_ID)).toBe(true);
    const deadline = Date.now() + 5_000;
    while (mesh.isExtensionRunning(EXTENSION_ID) && Date.now() < deadline) {
      await Bun.sleep(5);
    }
    expect(mesh.isExtensionRunning(EXTENSION_ID)).toBe(false);
    expect(h.clients[0]?.disconnectCalls).toBe(1);
  });

  test("a refused prepareSpawn rejects with its code, records persistent_error, leaves no slot", async () => {
    const healthDb = new Database(":memory:");
    openDbs.push(healthDb);
    LocalIndex.ensureSchema(healthDb);
    const h = harness();
    const source: ExtensionSlotSource = {
      listServiceIds: () => [SERVICE_ID],
      prepareSpawn: () =>
        Promise.reject(
          new ExtensionRunGrantError("ERR_EXTENSION_RUN_TREE_CHANGED", "tree digest changed"),
        ),
    };
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      healthDb,
      extensionSlots: source,
      createExtensionClient: h.createExtensionClient,
    });
    const err = await mesh.listExtensionTools(SERVICE_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExtensionRunGrantError);
    expect((err as ExtensionRunGrantError).code).toBe("ERR_EXTENSION_RUN_TREE_CHANGED");
    const snap = getConnectorHealth(healthDb, SERVICE_ID);
    expect(snap.state).toBe("error");
    expect(snap.lastError ?? "").toContain("ERR_EXTENSION_RUN_TREE_CHANGED");
    expect(slots(mesh).has(extensionMeshKey(SERVICE_ID))).toBe(false);
    expect(h.clients).toHaveLength(0);
  });

  test("with no health DB, or a non-grant error, the refusal still rejects and records nothing", async () => {
    const h = harness();
    const refusal = new ExtensionRunGrantError("ERR_EXTENSION_RUN_NOT_APPROVED", "revoked");
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      extensionSlots: {
        listServiceIds: () => [SERVICE_ID],
        prepareSpawn: () => Promise.reject(refusal),
      },
      createExtensionClient: h.createExtensionClient,
    });
    await expect(mesh.listExtensionTools(SERVICE_ID)).rejects.toBe(refusal);
    await mesh.disconnect();

    const healthDb = new Database(":memory:");
    openDbs.push(healthDb);
    LocalIndex.ensureSchema(healthDb);
    const boom = new Error("disk gone");
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      healthDb,
      extensionSlots: {
        listServiceIds: () => [SERVICE_ID],
        prepareSpawn: () => Promise.reject(boom),
      },
      createExtensionClient: h.createExtensionClient,
    });
    await expect(mesh.listExtensionTools(SERVICE_ID)).rejects.toBe(boom);
    expect(getConnectorHealth(healthDb, SERVICE_ID).state).not.toBe("error");
    expect(h.clients).toHaveLength(0);
  });

  test("the default client factory builds an unconnected MCPClient", async () => {
    const client = defaultCreateExtensionClient(`nimbus-extension-test-${Date.now()}`, {
      [SERVICE_ID]: { command: "echo-server", args: [], env: {} },
    });
    expect(client).toBeInstanceOf(RealMCPClient);
    await client.disconnect();
  });

  test("a stop while prepareSpawn is in flight (grant gone) creates no client", async () => {
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    const h = harness({ prepare: () => held });
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      extensionSlots: h.source,
      createExtensionClient: h.createExtensionClient,
    });
    const pending = mesh.listExtensionTools(SERVICE_ID);
    await Bun.sleep(0);
    expect(h.prepareCalls).toBe(1);
    h.setListed([]);
    release();
    expect(await pending).toBeUndefined();
    expect(h.clients).toHaveLength(0);
    expect(mesh.isExtensionRunning(EXTENSION_ID)).toBe(false);
  });

  test("listToolsForDispatcher's merged map holds no ext_ key while an ext slot is live", async () => {
    const h = harness();
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      extensionSlots: h.source,
      createExtensionClient: h.createExtensionClient,
    });
    await mesh.listExtensionTools(SERVICE_ID);
    // The filesystem client would spawn a real server: replace it with an empty fake.
    (mesh as unknown as { filesystem: unknown }).filesystem = {
      listTools: (): Promise<FakeTools> => Promise.resolve({}),
      disconnect: (): Promise<void> => Promise.resolve(),
    };
    const merged = await mesh.listToolsForDispatcher();
    expect(Object.keys(merged).filter((k) => k.startsWith("ext_"))).toEqual([]);
    expect(slots(mesh).get(extensionMeshKey(SERVICE_ID))?.client).toBeDefined();
  });

  test("extensionSpawnGate: nothing is prepared until the gate resolves", async () => {
    const { promise: gate, resolve: open } = Promise.withResolvers<void>();
    const h = harness();
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      extensionSlots: h.source,
      extensionSpawnGate: gate,
      createExtensionClient: h.createExtensionClient,
    });
    const pending = mesh.listExtensionTools(SERVICE_ID);
    await Bun.sleep(0);
    expect(h.prepareCalls).toBe(0);
    open();
    expect(Object.keys((await pending) ?? {})).toEqual(["ext_foo_echo"]);
    expect(h.prepareCalls).toBe(1);
  });

  test("ForDispatcher wraps each tool in the slot's drain refcount", async () => {
    const h = harness();
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      extensionSlots: h.source,
      createExtensionClient: h.createExtensionClient,
    });
    const tools = await mesh.listExtensionToolsForDispatcher(SERVICE_ID);
    const drain = slots(mesh).get(extensionMeshKey(SERVICE_ID))?.drain;
    let countDuring = -1;
    const call = tools?.["ext_foo_echo"]?.execute?.({});
    countDuring = drain?.count ?? -1;
    expect(await call).toBe("echo");
    expect(countDuring).toBe(1);
    expect(drain?.count).toBe(0);
    expect(await mesh.listExtensionToolsForDispatcher("ext_missing")).toBeUndefined();
  });

  test("listOwnerCodeServerTools routes by prefix", async () => {
    const h = harness();
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      extensionSlots: h.source,
      createExtensionClient: h.createExtensionClient,
      listUserMcpConnectors: () => [],
    });
    expect(Object.keys((await mesh.listOwnerCodeServerTools(SERVICE_ID)) ?? {})).toEqual([
      "ext_foo_echo",
    ]);
    expect(
      Object.keys((await mesh.listOwnerCodeServerToolsForDispatcher(SERVICE_ID)) ?? {}),
    ).toEqual(["ext_foo_echo"]);
    expect(await mesh.listOwnerCodeServerTools("mcp_missing")).toBeUndefined();
    expect(await mesh.listOwnerCodeServerToolsForDispatcher("mcp_missing")).toBeUndefined();
  });
});

describe("removeExtensionSandbox", () => {
  test("deletes the ext.<serviceId> leaf and never throws on a missing one", async () => {
    const paths = makePaths();
    mesh = new LazyConnectorMesh(paths, createMockVault());
    const leaf = sandboxCwdFor(paths.sandboxDir, `ext.${SERVICE_ID}`);
    mkdirSync(leaf, { recursive: true });
    await mesh.removeExtensionSandbox(SERVICE_ID);
    expect(existsSync(leaf)).toBe(false);
    await expect(mesh.removeExtensionSandbox(SERVICE_ID)).resolves.toBeUndefined();
  });

  test("a delete that keeps failing is retried three times and never throws", async () => {
    let calls = 0;
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      removeSandboxDir: () => {
        calls += 1;
        throw new Error("EBUSY");
      },
    });
    await expect(mesh.removeExtensionSandbox(SERVICE_ID)).resolves.toBeUndefined();
    expect(calls).toBe(3);
  });
});
