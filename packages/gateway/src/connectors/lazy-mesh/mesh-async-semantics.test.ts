/**
 * The async SHAPE of the lazy mesh, pinned where a refactor can quietly change it.
 *
 * 1. Three slot walks run concurrently: `disconnect()`, the stale-user-slot reconcile and the
 *    refcount listing. They used to `await` one slot at a time, so in the two teardown walks a
 *    single slot draining in-flight calls (up to ten minutes) held back every slot after it. Each
 *    test observes the other slots in the SAME turn as the call — before anything has resolved —
 *    which a one-at-a-time walk cannot satisfy, and pins that results are still taken in SLOT
 *    order, not in the order the listings happened to finish.
 * 2. The user-tool listing is the exception and stays one slot at a time: a user slot's first
 *    listing spawns its user-configured server, and the user-MCP count is uncapped. Its test pins
 *    the opposite observation — the next slot is NOT listed while the first is still answering.
 * 3. Three functions dropped an `async` they did not need but kept the Promise their callers
 *    await. A throw from the synchronous body must still arrive as a REJECTION, never as a throw
 *    out of the call itself: `Promise.try` preserves that, a `Promise.resolve` rewrite would not.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MCPClient } from "@mastra/mcp";

import type { PlatformPaths } from "../../platform/paths.ts";
import { createMockVault } from "../../vault/mock.ts";
import { ensureObsidianMcp } from "./connector-spawns.ts";
import { LazyDrainTracker } from "./drain.ts";
import { LAZY_MESH, userMcpMeshKey } from "./keys.ts";
import { createLazyConnectorMesh, LazyConnectorMesh } from "./mesh.ts";
import type { LazyMcpSlot, MeshSpawnContext } from "./slot.ts";
import type { LazyMeshToolMap } from "./tool-map.ts";

const createdRoots: string[] = [];
const heldDrains: LazyDrainTracker[] = [];
let mesh: LazyConnectorMesh | undefined;

/** One call in flight; also released in `afterEach`, so a failing test cannot stall teardown. */
function heldDrain(): LazyDrainTracker {
  const drain = new LazyDrainTracker();
  drain.bump();
  heldDrains.push(drain);
  return drain;
}

function makePaths(): PlatformPaths {
  const root = mkdtempSync(join(tmpdir(), "nimbus-mesh-async-"));
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
  for (const drain of heldDrains.splice(0)) {
    drain.drop(); // a no-op when the test already released it
  }
  if (mesh !== undefined) {
    await mesh.disconnect();
    mesh = undefined;
  }
  for (const root of createdRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

type FakeTools = Record<string, { execute?: (i: unknown, c?: unknown) => Promise<unknown> }>;

interface FakeClient {
  listTools(): Promise<FakeTools>;
  disconnect(): Promise<void>;
  readonly listToolsCalls: number;
  readonly disconnectCalls: number;
}

/** A stand-in MCP client. `gate` holds its listing open until the test releases it. */
function fakeClient(opts: { tools?: FakeTools; gate?: Promise<void>; fails?: boolean } = {}) {
  let listToolsCalls = 0;
  let disconnectCalls = 0;
  const client: FakeClient = {
    async listTools(): Promise<FakeTools> {
      listToolsCalls += 1;
      await (opts.gate ?? Promise.resolve());
      if (opts.fails === true) throw new Error("slot vanished mid-listing");
      return opts.tools ?? {};
    },
    disconnect(): Promise<void> {
      disconnectCalls += 1;
      return Promise.resolve();
    },
    get listToolsCalls(): number {
      return listToolsCalls;
    },
    get disconnectCalls(): number {
      return disconnectCalls;
    },
  };
  return client;
}

function gate(): { promise: Promise<void>; open: () => void } {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, open: () => resolve() };
}

function tool(result: string): FakeTools[string] {
  return { execute: (): Promise<unknown> => Promise.resolve(result) };
}

/** The private members these tests drive directly — the same cast `mesh.test.ts` uses. */
type MeshInternals = {
  filesystem: FakeClient;
  lazySlots: Map<string, LazyMcpSlot>;
  ensureUserMcpConnectorsRunning(): Promise<void>;
  collectUserMcpToolMap(): Promise<LazyMeshToolMap>;
  buildSlotForToolMap(): Promise<Map<string, LazyDrainTracker>>;
};

function internals(m: LazyConnectorMesh): MeshInternals {
  return m as unknown as MeshInternals;
}

function addSlot(
  m: LazyConnectorMesh,
  key: string,
  client: FakeClient,
  drain = new LazyDrainTracker(),
): void {
  internals(m).lazySlots.set(key, {
    client: client as unknown as MCPClient,
    idleTimer: undefined,
    drain,
  });
}

describe("lazy mesh slot walks run concurrently, and still answer in slot order", () => {
  test("disconnect(): a slot draining in-flight calls does not hold back the others", async () => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault());
    const fs = fakeClient();
    internals(mesh).filesystem = fs;
    const busyDrain = heldDrain();
    const busy = fakeClient();
    const idle = fakeClient();
    addSlot(mesh, LAZY_MESH.jira, busy, busyDrain); // first in slot order
    addSlot(mesh, LAZY_MESH.linear, idle);

    const done = mesh.disconnect();

    // Same turn as the call: the idle slot is already gone while jira still waits on its call.
    expect(idle.disconnectCalls).toBe(1);
    expect(busy.disconnectCalls).toBe(0);
    expect(fs.disconnectCalls).toBe(0); // the filesystem client still goes last

    busyDrain.drop();
    await done;
    expect(busy.disconnectCalls).toBe(1);
    expect(fs.disconnectCalls).toBe(1);
    expect(internals(mesh).lazySlots.size).toBe(0);
  });

  test("reconcile stops every stale user slot at once and keeps active and built-in slots", async () => {
    const rows = [{ service_id: "mcp_keep", command: "/bin/echo", args_json: "[]", created_at: 0 }];
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      listUserMcpConnectors: () => rows,
    });
    const busyDrain = heldDrain();
    const staleBusy = fakeClient();
    const staleIdle = fakeClient();
    const kept = fakeClient();
    const builtIn = fakeClient();
    addSlot(mesh, userMcpMeshKey("mcp_gone_busy"), staleBusy, busyDrain); // first in slot order
    addSlot(mesh, userMcpMeshKey("mcp_gone_idle"), staleIdle);
    addSlot(mesh, userMcpMeshKey("mcp_keep"), kept);
    addSlot(mesh, LAZY_MESH.github, builtIn);

    const done = internals(mesh).ensureUserMcpConnectorsRunning();

    expect(staleIdle.disconnectCalls).toBe(1);
    expect(staleBusy.disconnectCalls).toBe(0);

    busyDrain.drop();
    await done;
    const slots = internals(mesh).lazySlots;
    expect(staleBusy.disconnectCalls).toBe(1);
    expect(slots.has(userMcpMeshKey("mcp_gone_busy"))).toBe(false);
    expect(slots.has(userMcpMeshKey("mcp_gone_idle"))).toBe(false);
    // The active row's slot already existed, so the reconcile only re-arms its idle timer.
    expect(kept.disconnectCalls).toBe(0);
    expect(slots.has(userMcpMeshKey("mcp_keep"))).toBe(true);
    expect(builtIn.disconnectCalls).toBe(0);
    expect(slots.has(LAZY_MESH.github)).toBe(true);
  });

  test("the refcount map lists slots together; a tool maps to the FIRST slot listing it", async () => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault());
    const firstGate = gate();
    const firstDrain = new LazyDrainTracker();
    const lastDrain = new LazyDrainTracker();
    const first = fakeClient({
      tools: { dup_tool: tool("a"), first_only: tool("a") },
      gate: firstGate.promise,
    });
    const broken = fakeClient({ fails: true });
    const last = fakeClient({ tools: { dup_tool: tool("b"), last_only: tool("b") } });
    addSlot(mesh, LAZY_MESH.github, first, firstDrain);
    addSlot(mesh, LAZY_MESH.slack, broken);
    addSlot(mesh, LAZY_MESH.linear, last, lastDrain);

    const pending = internals(mesh).buildSlotForToolMap();

    expect(first.listToolsCalls).toBe(1);
    expect(broken.listToolsCalls).toBe(1);
    expect(last.listToolsCalls).toBe(1);

    firstGate.open();
    const slotForTool = await pending;
    expect(slotForTool.get("dup_tool")).toBe(firstDrain); // first in order, though it answered last
    expect(slotForTool.get("first_only")).toBe(firstDrain);
    expect(slotForTool.get("last_only")).toBe(lastDrain);
    expect(slotForTool.size).toBe(3); // the failing slot is skipped, not fatal
  });
});

describe("the user-tool listing stays one slot at a time", () => {
  test("the next user slot is not listed until the previous one answers; later slots win", async () => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault());
    const firstGate = gate();
    const first = fakeClient({
      tools: { shared_tool: tool("first"), first_only: tool("first") },
      gate: firstGate.promise,
    });
    const builtIn = fakeClient({ tools: { github_repos: tool("github") } });
    const second = fakeClient({ tools: { shared_tool: tool("second") } });
    addSlot(mesh, userMcpMeshKey("mcp_first"), first);
    addSlot(mesh, LAZY_MESH.github, builtIn);
    addSlot(mesh, userMcpMeshKey("mcp_second"), second);

    const pending = internals(mesh).collectUserMcpToolMap();

    // A user slot's first listing spawns its server, so the second must wait for the first.
    expect(first.listToolsCalls).toBe(1);
    expect(second.listToolsCalls).toBe(0);
    expect(builtIn.listToolsCalls).toBe(0); // only user slots are collected here

    firstGate.open();
    const merged = await pending;
    expect(second.listToolsCalls).toBe(1);
    expect(builtIn.listToolsCalls).toBe(0);
    expect(Object.keys(merged).sort((a, b) => a.localeCompare(b))).toEqual([
      "first_only",
      "shared_tool",
    ]);
    // A later slot wins a shared name: the merge spreads each slot's map over the ones before it.
    expect(await merged["shared_tool"]?.execute?.({})).toBe("second");
  });
});

describe("Promise-returning functions report a throw as a rejection, never a synchronous throw", () => {
  test("createLazyConnectorMesh: a throwing constructor rejects", async () => {
    const options = {
      get inactivityMs(): number {
        throw new Error("unreadable mesh options");
      },
    };
    let created: Promise<LazyConnectorMesh> | undefined;
    expect(() => {
      created = createLazyConnectorMesh(makePaths(), createMockVault(), options);
    }).not.toThrow();
    await expect(created).rejects.toThrow("unreadable mesh options");
  });

  test("ensureUserMcpRunning: a failing row lookup rejects", async () => {
    const m = new LazyConnectorMesh(makePaths(), createMockVault(), {
      listUserMcpConnectors: () => {
        throw new Error("user MCP rows unreadable");
      },
    });
    mesh = m;
    let ensured: Promise<void> | undefined;
    expect(() => {
      ensured = m.ensureUserMcpRunning("mcp_any");
    }).not.toThrow();
    await expect(ensured).rejects.toThrow("user MCP rows unreadable");
  });

  test("ensureObsidianMcp: a throw from its synchronous body rejects", async () => {
    const neverReached = (): never => {
      throw new Error("unreachable: clearLazyIdle throws first");
    };
    const ctx: MeshSpawnContext = {
      vault: createMockVault(),
      obsidianVaultPaths: ["/notes"],
      sandboxCwd: makePaths().dataDir,
      clearLazyIdle: (): void => {
        throw new Error("slot map unavailable");
      },
      getLazyClient: neverReached,
      setLazyClient: neverReached,
      bumpToolsEpoch: neverReached,
      scheduleLazyDisconnect: neverReached,
    };
    let started: Promise<void> | undefined;
    expect(() => {
      started = ensureObsidianMcp(ctx);
    }).not.toThrow();
    await expect(started).rejects.toThrow("slot map unavailable");
  });
});
