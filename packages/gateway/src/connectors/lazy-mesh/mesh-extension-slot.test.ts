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
import { extensionStageRootFor, sandboxCwdFor } from "../../platform/sandbox/sandbox-cwd.ts";
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
  listToolsWithErrors(): Promise<{ tools: FakeTools; errors: Record<string, string> }>;
  disconnect(): Promise<void>;
  disconnectCalls: number;
  listToolsCalls: number;
}

/** A fake source plus a recording client factory. */
function harness(
  opts: {
    listed?: () => readonly string[];
    prepare?: () => Promise<void>;
    /** Called per preparation (1-based); a returned error is thrown as the refusal. */
    refuse?: (call: number) => Error | undefined;
    /** Per client (0-based); the promise its disconnect() returns. Default: resolved. */
    disconnect?: (index: number) => Promise<void>;
    /** Per client (0-based); a per-server start error `listToolsWithErrors` reports. */
    startError?: (index: number) => string | undefined;
    /** Replaces the default `echo` tool map. */
    tools?: (serverKey: string) => FakeTools;
  } = {},
) {
  let prepareCalls = 0;
  let discards = 0;
  const clients: FakeClient[] = [];
  let listed: readonly string[] = [SERVICE_ID];
  let allowed = true;
  let disabled: string | undefined;
  const source: ExtensionSlotSource = {
    listServiceIds: () => (opts.listed === undefined ? listed : opts.listed()),
    isAllowed: () => allowed,
    disabledExtensionIdFor: () => disabled,
    async prepareSpawn(serviceId: string): Promise<PreparedExtensionSpawn> {
      prepareCalls += 1;
      const refusal = opts.refuse?.(prepareCalls);
      if (refusal !== undefined) throw refusal;
      await (opts.prepare?.() ?? Promise.resolve());
      return {
        extensionId: EXTENSION_ID,
        serviceId,
        spec: { command: "echo-server", args: [], env: {} },
        discard: () => {
          discards += 1;
        },
      };
    },
  };
  const createExtensionClient = (id: string, servers: Record<string, ServerSpec>): MCPClient => {
    const serverKey = Object.keys(servers)[0] ?? "";
    const tools = (): FakeTools =>
      opts.tools?.(serverKey) ?? {
        [`${serverKey}_echo`]: { execute: (): Promise<unknown> => Promise.resolve("echo") },
      };
    const client: FakeClient = {
      id,
      servers,
      listTools(): Promise<FakeTools> {
        client.listToolsCalls += 1;
        return Promise.resolve(tools());
      },
      listToolsWithErrors() {
        client.listToolsCalls += 1;
        const err = opts.startError?.(clients.indexOf(client));
        return Promise.resolve(
          err === undefined
            ? { tools: tools(), errors: {} }
            : { tools: {}, errors: { [serverKey]: err } },
        );
      },
      disconnect(): Promise<void> {
        client.disconnectCalls += 1;
        return opts.disconnect?.(clients.indexOf(client)) ?? Promise.resolve();
      },
      disconnectCalls: 0,
      listToolsCalls: 0,
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
    get discards(): number {
      return discards;
    },
    setListed(ids: readonly string[]): void {
      listed = ids;
    },
    setAllowed(v: boolean): void {
      allowed = v;
    },
    setDisabled(id: string | undefined): void {
      disabled = id;
    },
  };
}

/** The code of the `ExtensionRunGrantError` `p` rejects with (fails the test if it resolves). */
async function codeOf(p: Promise<unknown>): Promise<string> {
  const settled = await p.then(
    (v) => new Error(`resolved: ${JSON.stringify(v)}`),
    (e: unknown) => e,
  );
  expect(settled).toBeInstanceOf(ExtensionRunGrantError);
  return (settled as ExtensionRunGrantError).code;
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

  test("a listing during the previous child's late disconnect (explicit stop) does not prepare until it resolves", async () => {
    let release: () => void = () => {};
    const late = new Promise<void>((r) => {
      release = r;
    });
    const h = harness({ disconnect: (i) => (i === 0 ? late : Promise.resolve()) });
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      extensionSlots: h.source,
      createExtensionClient: h.createExtensionClient,
    });
    await mesh.listExtensionTools(SERVICE_ID);
    expect(h.prepareCalls).toBe(1);
    // Auto-update's shape: stop with the id still listed. The stop is NOT awaited, so the listing
    // below races the old child's disconnect.
    const stopped = mesh.stopExtensionClient(EXTENSION_ID);
    await Bun.sleep(0);
    expect(h.clients[0]?.disconnectCalls).toBe(1);
    const listing = mesh.listExtensionTools(SERVICE_ID);
    await Bun.sleep(20);
    expect(h.prepareCalls).toBe(1);
    expect(h.clients).toHaveLength(1);
    release();
    await stopped;
    expect(Object.keys((await listing) ?? {})).toEqual(["ext_foo_echo"]);
    expect(h.prepareCalls).toBe(2);
    expect(h.clients).toHaveLength(2);
  });

  test("a listing during an IDLE teardown's late disconnect does not prepare until it resolves", async () => {
    let release: () => void = () => {};
    const late = new Promise<void>((r) => {
      release = r;
    });
    const h = harness({ disconnect: (i) => (i === 0 ? late : Promise.resolve()) });
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      inactivityMs: 5,
      extensionSlots: h.source,
      createExtensionClient: h.createExtensionClient,
    });
    await mesh.listExtensionTools(SERVICE_ID);
    const deadline = Date.now() + 5_000;
    while ((h.clients[0]?.disconnectCalls ?? 0) === 0 && Date.now() < deadline) {
      await Bun.sleep(5);
    }
    expect(h.clients[0]?.disconnectCalls).toBe(1);
    const listing = mesh.listExtensionTools(SERVICE_ID);
    await Bun.sleep(20);
    expect(h.prepareCalls).toBe(1);
    release();
    expect(Object.keys((await listing) ?? {})).toEqual(["ext_foo_echo"]);
    expect(h.prepareCalls).toBe(2);
  });

  test("a stop landing DURING the wait for the previous child stages nothing: no prepareSpawn", async () => {
    const { promise: late, resolve: release } = Promise.withResolvers<void>();
    const h = harness({ disconnect: (i) => (i === 0 ? late : Promise.resolve()) });
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      extensionSlots: h.source,
      createExtensionClient: h.createExtensionClient,
    });
    await mesh.listExtensionTools(SERVICE_ID);
    const firstStop = mesh.stopExtensionClient(EXTENSION_ID);
    await Bun.sleep(0);
    const listing = mesh.listExtensionTools(SERVICE_ID);
    await Bun.sleep(0);
    // Auto-update's shape again, now while the listing is waiting: the id stays listed.
    const secondStop = mesh.stopExtensionClient(EXTENSION_ID);
    release();
    await Promise.all([firstStop, secondStop]);
    // Still listed, so it is not "not registered": the listing says it was stopped, retry.
    expect(await codeOf(listing)).toBe("ERR_EXTENSION_RUN_STOPPED");
    expect(h.prepareCalls).toBe(1);
    expect(h.clients).toHaveLength(1);
    // The next listing re-prepares normally.
    expect(Object.keys((await mesh.listExtensionTools(SERVICE_ID)) ?? {})).toEqual([
      "ext_foo_echo",
    ]);
    expect(h.prepareCalls).toBe(2);
  });

  test("a withdrawal landing DURING the wait for the previous child stages nothing", async () => {
    const { promise: late, resolve: release } = Promise.withResolvers<void>();
    const h = harness({ disconnect: (i) => (i === 0 ? late : Promise.resolve()) });
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      extensionSlots: h.source,
      createExtensionClient: h.createExtensionClient,
    });
    await mesh.listExtensionTools(SERVICE_ID);
    const stopped = mesh.stopExtensionClient(EXTENSION_ID);
    await Bun.sleep(0);
    const listing = mesh.listExtensionTools(SERVICE_ID);
    await Bun.sleep(0);
    h.setListed([]);
    release();
    await stopped;
    expect(await listing).toBeUndefined();
    expect(h.prepareCalls).toBe(1);
  });

  test("a refused prepareSpawn rejects with its code, records persistent_error, leaves no slot", async () => {
    const healthDb = new Database(":memory:");
    openDbs.push(healthDb);
    LocalIndex.ensureSchema(healthDb);
    const h = harness();
    const source: ExtensionSlotSource = {
      listServiceIds: () => [SERVICE_ID],
      isAllowed: () => true,
      disabledExtensionIdFor: () => undefined,
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
        isAllowed: () => true,
        disabledExtensionIdFor: () => undefined,
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
        isAllowed: () => true,
        disabledExtensionIdFor: () => undefined,
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

  test("withdrawal re-check: an id unlisted while prepareSpawn is in flight creates no client", async () => {
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
    expect(h.discards).toBe(1);
    expect(mesh.isExtensionRunning(EXTENSION_ID)).toBe(false);
  });

  test("a stop with NO withdrawal during an in-flight spawn creates no client; the next list re-prepares", async () => {
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    const h = harness({ prepare: () => held });
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      extensionSlots: h.source,
      createExtensionClient: h.createExtensionClient,
    });
    const pending = mesh.listExtensionTools(SERVICE_ID);
    await Bun.sleep(0);
    expect(h.prepareCalls).toBe(1);
    // Auto-update's shape: the tree is swapped and the client stopped, the id still listed.
    await mesh.stopExtensionClient(EXTENSION_ID);
    release();
    expect(await codeOf(pending)).toBe("ERR_EXTENSION_RUN_STOPPED");
    expect(h.clients).toHaveLength(0);
    expect(h.discards).toBe(1);
    expect(mesh.isExtensionRunning(EXTENSION_ID)).toBe(false);
    expect(slots(mesh).get(extensionMeshKey(SERVICE_ID))?.client).toBeUndefined();

    expect(Object.keys((await mesh.listExtensionTools(SERVICE_ID)) ?? {})).toEqual([
      "ext_foo_echo",
    ]);
    expect(h.prepareCalls).toBe(2);
    expect(h.clients).toHaveLength(1);
    expect(mesh.isExtensionRunning(EXTENSION_ID)).toBe(true);
  });

  test("disconnect() during an in-flight spawn creates no client", async () => {
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    const h = harness({ prepare: () => held });
    const m = new LazyConnectorMesh(makePaths(), createMockVault(), {
      extensionSlots: h.source,
      createExtensionClient: h.createExtensionClient,
    });
    mesh = m;
    const pending = m.listExtensionTools(SERVICE_ID);
    await Bun.sleep(0);
    expect(h.prepareCalls).toBe(1);
    await m.disconnect();
    release();
    expect(await codeOf(pending)).toBe("ERR_EXTENSION_RUN_STOPPED");
    expect(h.clients).toHaveLength(0);
    expect(slots(m).has(extensionMeshKey(SERVICE_ID))).toBe(false);
  });

  test("a stop of ANOTHER extension does not abort this one's in-flight spawn", async () => {
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    const h = harness({ prepare: () => held });
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      extensionSlots: h.source,
      createExtensionClient: h.createExtensionClient,
    });
    const pending = mesh.listExtensionTools(SERVICE_ID);
    await Bun.sleep(0);
    await mesh.stopExtensionClient("some-other-ext");
    release();
    expect(Object.keys((await pending) ?? {})).toEqual(["ext_foo_echo"]);
    expect(mesh.isExtensionRunning(EXTENSION_ID)).toBe(true);
  });

  test("a refused prepareSpawn followed by a successful retry: error, then healthy", async () => {
    const healthDb = new Database(":memory:");
    openDbs.push(healthDb);
    LocalIndex.ensureSchema(healthDb);
    const h = harness({
      refuse: (call) =>
        call === 1
          ? new ExtensionRunGrantError("ERR_EXTENSION_RUN_TREE_CHANGED", "tree digest changed")
          : undefined,
    });
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      healthDb,
      extensionSlots: h.source,
      createExtensionClient: h.createExtensionClient,
    });
    await expect(mesh.listExtensionTools(SERVICE_ID)).rejects.toBeInstanceOf(
      ExtensionRunGrantError,
    );
    expect(getConnectorHealth(healthDb, SERVICE_ID).state).toBe("error");

    expect(Object.keys((await mesh.listExtensionTools(SERVICE_ID)) ?? {})).toEqual([
      "ext_foo_echo",
    ]);
    expect(h.prepareCalls).toBe(2);
    const snap = getConnectorHealth(healthDb, SERVICE_ID);
    expect(snap.state).toBe("healthy");
    expect(snap.lastError).toBeUndefined();
  });

  test("a first successful spawn of a never-observed id writes no health row", async () => {
    const healthDb = new Database(":memory:");
    openDbs.push(healthDb);
    LocalIndex.ensureSchema(healthDb);
    const h = harness();
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      healthDb,
      extensionSlots: h.source,
      createExtensionClient: h.createExtensionClient,
    });
    await mesh.listExtensionTools(SERVICE_ID);
    expect(getConnectorHealth(healthDb, SERVICE_ID).state).toBe("not_configured");
  });

  test("listToolsForDispatcher never lists a live ext slot and its merged map holds no ext_ key", async () => {
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
    const callsBefore = h.clients[0]?.listToolsCalls ?? -1;
    const merged = await mesh.listToolsForDispatcher();
    expect(h.clients[0]?.listToolsCalls).toBe(callsBefore);
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

describe("mesh:ext: slot — policy, start failure, disabled", () => {
  test("org policy re-read on REUSE: a tightened allowlist stops the live child and refuses POLICY", async () => {
    const healthDb = new Database(":memory:");
    openDbs.push(healthDb);
    LocalIndex.ensureSchema(healthDb);
    const h = harness();
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      healthDb,
      extensionSlots: h.source,
      createExtensionClient: h.createExtensionClient,
    });
    await mesh.listExtensionTools(SERVICE_ID);
    expect(mesh.isExtensionRunning(EXTENSION_ID)).toBe(true);
    h.setAllowed(false);
    expect(await codeOf(mesh.listExtensionTools(SERVICE_ID))).toBe("ERR_EXTENSION_RUN_POLICY");
    expect(h.clients[0]?.disconnectCalls).toBe(1);
    expect(mesh.isExtensionRunning(EXTENSION_ID)).toBe(false);
    expect(slots(mesh).get(extensionMeshKey(SERVICE_ID))?.client).toBeUndefined();
    expect(getConnectorHealth(healthDb, SERVICE_ID).lastError ?? "").toContain(
      "ERR_EXTENSION_RUN_POLICY",
    );
    // Allowed again: the next listing spawns afresh (re-verified), not the stopped client.
    h.setAllowed(true);
    expect(Object.keys((await mesh.listExtensionTools(SERVICE_ID)) ?? {})).toEqual([
      "ext_foo_echo",
    ]);
    expect(h.prepareCalls).toBe(2);
  });

  test("a child that failed to start rejects START_FAILED, records it, and is not left running", async () => {
    const healthDb = new Database(":memory:");
    openDbs.push(healthDb);
    LocalIndex.ensureSchema(healthDb);
    const h = harness({ startError: (i) => (i === 0 ? "spawn EPERM" : undefined) });
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      healthDb,
      extensionSlots: h.source,
      createExtensionClient: h.createExtensionClient,
    });
    const err = await mesh.listExtensionTools(SERVICE_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExtensionRunGrantError);
    expect((err as ExtensionRunGrantError).code).toBe("ERR_EXTENSION_RUN_START_FAILED");
    expect((err as Error).message).toContain("spawn EPERM");
    expect(h.clients[0]?.disconnectCalls).toBe(1);
    expect(mesh.isExtensionRunning(EXTENSION_ID)).toBe(false);
    expect(slots(mesh).get(extensionMeshKey(SERVICE_ID))?.client).toBeUndefined();
    const snap = getConnectorHealth(healthDb, SERVICE_ID);
    expect(snap.state).toBe("error");
    expect(snap.lastError ?? "").toContain("ERR_EXTENSION_RUN_START_FAILED");
    // The retry spawns a fresh child, and its success clears the recorded error.
    expect(Object.keys((await mesh.listExtensionTools(SERVICE_ID)) ?? {})).toEqual([
      "ext_foo_echo",
    ]);
    expect(getConnectorHealth(healthDb, SERVICE_ID).state).toBe("healthy");
  });

  test("an approved-but-disabled extension refuses DISABLED naming it, not 'not registered'", async () => {
    const h = harness();
    h.setListed([]);
    h.setDisabled(EXTENSION_ID);
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      extensionSlots: h.source,
      createExtensionClient: h.createExtensionClient,
    });
    const err = await mesh.listExtensionTools(SERVICE_ID).catch((e: unknown) => e);
    expect((err as ExtensionRunGrantError).code).toBe("ERR_EXTENSION_RUN_DISABLED");
    expect((err as Error).message).toContain(`nimbus extension enable ${EXTENSION_ID}`);
    expect(h.prepareCalls).toBe(0);
  });

  test("a disable landing mid-preparation refuses DISABLED and creates no client", async () => {
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    const h = harness({ prepare: () => held });
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      extensionSlots: h.source,
      createExtensionClient: h.createExtensionClient,
    });
    const pending = mesh.listExtensionTools(SERVICE_ID);
    await Bun.sleep(0);
    h.setListed([]);
    h.setDisabled(EXTENSION_ID);
    release();
    expect(await codeOf(pending)).toBe("ERR_EXTENSION_RUN_DISABLED");
    expect(h.clients).toHaveLength(0);
  });
});

describe("removeExtensionSandbox", () => {
  test("deletes the stage root AND the old ext.<serviceId> leaf, and never throws on missing ones", async () => {
    const paths = makePaths();
    mesh = new LazyConnectorMesh(paths, createMockVault());
    const leaf = sandboxCwdFor(paths.sandboxDir, `ext.${SERVICE_ID}`);
    const stageRoot = extensionStageRootFor(paths.sandboxDir, SERVICE_ID);
    mkdirSync(leaf, { recursive: true });
    mkdirSync(join(stageRoot, "some-stage"), { recursive: true });
    await mesh.removeExtensionSandbox(SERVICE_ID);
    expect(existsSync(leaf)).toBe(false);
    expect(existsSync(stageRoot)).toBe(false);
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
    // Three attempts for each of the two directories.
    expect(calls).toBe(6);
  });
});

const SYNC_REQ = { cursor: null, depth: "full" as const };
const textResult = (text: string, isError = false) => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
});

function syncMesh(h: ReturnType<typeof harness>): LazyConnectorMesh {
  mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
    extensionSlots: h.source,
    createExtensionClient: h.createExtensionClient,
  });
  return mesh;
}

describe("reserved sync tool", () => {
  test("reserved key filtered on the unprefixed name", async () => {
    const h = harness({
      tools: (k) => ({
        [`${k}___nimbus_sync`]: { execute: () => Promise.resolve(textResult("{}")) },
        [`${k}_list`]: { execute: () => Promise.resolve("l") },
      }),
    });
    const m = syncMesh(h);
    expect(Object.keys((await m.listExtensionTools(SERVICE_ID)) ?? {})).toEqual(["ext_foo_list"]);
    expect(Object.keys((await m.listExtensionToolsForDispatcher(SERVICE_ID)) ?? {})).toEqual([
      "ext_foo_list",
    ]);
  });

  test("a tool whose unprefixed name merely contains __nimbus_ later is not reserved", async () => {
    const h = harness({
      tools: (k) => ({ [`${k}_a__nimbus_b`]: { execute: () => Promise.resolve("x") } }),
    });
    const m = syncMesh(h);
    expect(Object.keys((await m.listExtensionTools(SERVICE_ID)) ?? {})).toEqual([
      "ext_foo_a__nimbus_b",
    ]);
  });

  test("callExtensionSyncTool unwraps the CallToolResult envelope and rejects isError", async () => {
    let seen: unknown;
    let reply = textResult(JSON.stringify({ status: "ok", n: 1 }));
    const h = harness({
      tools: (k) => ({
        [`${k}___nimbus_sync`]: {
          execute: (input: unknown) => {
            seen = input;
            return Promise.resolve(reply);
          },
        },
      }),
    });
    const m = syncMesh(h);
    expect(await m.callExtensionSyncTool(SERVICE_ID, SYNC_REQ, 1000)).toEqual({
      status: "ok",
      n: 1,
    });
    expect(seen).toEqual(SYNC_REQ);
    reply = textResult("nope", true);
    await expect(m.callExtensionSyncTool(SERVICE_ID, SYNC_REQ, 1000)).rejects.toThrow(/error/);
  });

  test("a 5 MiB sync result is rejected", async () => {
    const h = harness({
      tools: (k) => ({
        [`${k}___nimbus_sync`]: {
          execute: () => Promise.resolve(textResult("x".repeat(5 * 1024 * 1024))),
        },
      }),
    });
    await expect(syncMesh(h).callExtensionSyncTool(SERVICE_ID, SYNC_REQ, 1000)).rejects.toThrow(
      /cap/,
    );
  });

  test("a call past the timeout rejects", async () => {
    let signal: AbortSignal | undefined;
    const h = harness({
      tools: (k) => ({
        [`${k}___nimbus_sync`]: {
          execute: (_input: unknown, ctx?: unknown) => {
            signal = (ctx as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
            // Never settles: the drain is released by the timeout, so the afterEach stop is prompt.
            return new Promise<unknown>(() => undefined);
          },
        },
      }),
    });
    await expect(syncMesh(h).callExtensionSyncTool(SERVICE_ID, SYNC_REQ, 20)).rejects.toThrow(
      /exceeded 20ms/,
    );
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(true);
  });

  test("a sync call that ignores the abort does not hold a stop past its timeout", async () => {
    const h = harness({
      tools: (k) => ({
        [`${k}___nimbus_sync`]: {
          // Ignores the abort signal and never settles.
          execute: () => new Promise<unknown>(() => undefined),
        },
      }),
    });
    const m = syncMesh(h);
    await expect(m.callExtensionSyncTool(SERVICE_ID, SYNC_REQ, 20)).rejects.toThrow(
      /exceeded 20ms/,
    );
    let stopped = false;
    const stop = m.stopExtensionClient(EXTENSION_ID).then(() => {
      stopped = true;
    });
    // Holding the drain until the abandoned call settles would park this stop on the ten-minute
    // drain cap; released with the race, it completes at once.
    await Promise.race([stop, Bun.sleep(1000)]);
    expect(stopped).toBe(true);
    expect(h.clients[0]?.disconnectCalls).toBe(1);
  });

  test("an extension without the sync tool, or an unlisted id, is refused", async () => {
    const m = syncMesh(harness());
    await expect(m.callExtensionSyncTool(SERVICE_ID, SYNC_REQ, 100)).rejects.toThrow(
      /does not expose the sync tool/,
    );
    await expect(m.callExtensionSyncTool("ext_other", SYNC_REQ, 100)).rejects.toThrow(
      /not an approved extension/,
    );
  });

  test("stop() during an in-flight sync waits for it", async () => {
    let release: (v: unknown) => void = () => undefined;
    const h = harness({
      tools: (k) => ({
        [`${k}___nimbus_sync`]: {
          execute: () =>
            new Promise<unknown>((r) => {
              release = r;
            }),
        },
      }),
    });
    const m = syncMesh(h);
    const call = m.callExtensionSyncTool(SERVICE_ID, SYNC_REQ, 5000);
    // let the call reach execute()
    for (let i = 0; i < 20 && h.clients.length === 0; i += 1) await Bun.sleep(5);
    await Bun.sleep(10);
    let stopped = false;
    const stop = m.stopExtensionClient(EXTENSION_ID).then(() => {
      stopped = true;
    });
    await Bun.sleep(50);
    expect(stopped).toBe(false);
    expect(h.clients[0]?.disconnectCalls).toBe(0);
    release(textResult("{}"));
    await call;
    await stop;
    expect(stopped).toBe(true);
    expect(h.clients[0]?.disconnectCalls).toBe(1);
  });
});
