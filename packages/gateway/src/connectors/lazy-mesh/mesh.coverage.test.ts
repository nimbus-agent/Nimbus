/**
 * Lazy-mesh paths the other mesh test files leave open: the idle timer actually firing, a slot
 * re-armed while it drains, a slot with no client, the `ensure<Service>Running` delegators, the
 * org-policy (I22) tool filter, and listing entries that carry nothing to wrap.
 *
 * Slots are driven through the same private-member cast `mesh.test.ts` and
 * `mesh-async-semantics.test.ts` use: the idle machinery is private, and the alternative —
 * spawning real MCP servers to reach it — would test the servers, not the mesh.
 */
import { afterEach, describe, expect, jest, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MCPClient } from "@mastra/mcp";

import type { PlatformPaths } from "../../platform/paths.ts";
import { createMockVault } from "../../vault/mock.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { LazyDrainTracker } from "./drain.ts";
import { LAZY_MESH } from "./keys.ts";
import { LazyConnectorMesh } from "./mesh.ts";
import type { LazyMcpSlot } from "./slot.ts";

type FakeTools = Record<string, { execute?: (i: unknown, c?: unknown) => Promise<unknown> }>;

interface FakeClient {
  listTools(): Promise<FakeTools>;
  disconnect(): Promise<void>;
  readonly disconnectCalls: number;
}

function fakeClient(tools: FakeTools = {}): FakeClient {
  let disconnectCalls = 0;
  return {
    listTools: (): Promise<FakeTools> => Promise.resolve(tools),
    disconnect(): Promise<void> {
      disconnectCalls += 1;
      return Promise.resolve();
    },
    get disconnectCalls(): number {
      return disconnectCalls;
    },
  };
}

function tool(result: string): FakeTools[string] {
  return { execute: (): Promise<unknown> => Promise.resolve(result) };
}

type MeshInternals = {
  filesystem: FakeClient;
  lazySlots: Map<string, LazyMcpSlot>;
  scheduleLazyDisconnect(key: string): void;
  stopLazyClient(key: string): Promise<void>;
};

function internals(m: LazyConnectorMesh): MeshInternals {
  return m as unknown as MeshInternals;
}

function addSlot(
  m: LazyConnectorMesh,
  key: string,
  client: FakeClient | undefined,
  drain = new LazyDrainTracker(),
): void {
  internals(m).lazySlots.set(key, {
    client: client as unknown as MCPClient | undefined,
    idleTimer: undefined,
    drain,
  });
}

const createdRoots: string[] = [];
const heldDrains: LazyDrainTracker[] = [];
let mesh: LazyConnectorMesh | undefined;

function makePaths(): PlatformPaths {
  const root = mkdtempSync(join(tmpdir(), "nimbus-mesh-cov-"));
  createdRoots.push(root);
  return {
    configDir: join(root, "config"),
    dataDir: join(root, "data"),
    logDir: join(root, "log"),
    socketPath: join(root, "sock"),
    extensionsDir: join(root, "ext"),
    tempDir: join(root, "tmp"),
  };
}

afterEach(async () => {
  for (const drain of heldDrains.splice(0)) drain.drop();
  if (mesh !== undefined) {
    await mesh.disconnect();
    mesh = undefined;
  }
  for (const root of createdRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("idle teardown", () => {
  test("an idle slot is stopped when its inactivity timer fires, and not a millisecond before", () => {
    // Fake timers: the timer is five minutes, and the point is to watch it fire, not to wait.
    jest.useFakeTimers();
    try {
      mesh = new LazyConnectorMesh(makePaths(), createMockVault(), { inactivityMs: 300_000 });
      const client = fakeClient();
      addSlot(mesh, LAZY_MESH.linear, client);

      internals(mesh).scheduleLazyDisconnect(LAZY_MESH.linear);
      jest.advanceTimersByTime(299_999);
      expect(client.disconnectCalls).toBe(0);
      expect(internals(mesh).lazySlots.has(LAZY_MESH.linear)).toBe(true);

      jest.advanceTimersByTime(1);
      // The stop runs synchronously up to the disconnect it awaits.
      expect(client.disconnectCalls).toBe(1);
      expect(internals(mesh).lazySlots.has(LAZY_MESH.linear)).toBe(false);
      expect(mesh.getToolsEpoch()).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a slot re-armed while it drains keeps its entry; only the client is let go", async () => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), { inactivityMs: 300_000 });
    const client = fakeClient();
    const drain = new LazyDrainTracker();
    drain.bump(); // one call in flight
    heldDrains.push(drain);
    addSlot(mesh, LAZY_MESH.jira, client, drain);

    const stopping = internals(mesh).stopLazyClient(LAZY_MESH.jira);
    // While the in-flight call drains, an ensure-call re-arms the idle timer for this slot.
    internals(mesh).scheduleLazyDisconnect(LAZY_MESH.jira);
    drain.drop();
    await stopping;

    const slot = internals(mesh).lazySlots.get(LAZY_MESH.jira);
    expect(client.disconnectCalls).toBe(1);
    expect(slot).toBeDefined();
    expect(slot?.client).toBeUndefined();
    expect(slot?.idleTimer).toBeDefined();
  });

  test("stopping a slot that holds no client removes it without bumping the tools epoch", async () => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault());
    addSlot(mesh, LAZY_MESH.discord, undefined);

    await internals(mesh).stopLazyClient(LAZY_MESH.discord);

    expect(internals(mesh).lazySlots.has(LAZY_MESH.discord)).toBe(false);
    expect(mesh.getToolsEpoch()).toBe(0);
  });
});

/** An empty vault that records every key read through it. */
function recordingVault(): { vault: NimbusVault; reads: string[] } {
  const inner = createMockVault();
  const reads: string[] = [];
  return {
    reads,
    vault: {
      get: (key: string): Promise<string | null> => {
        reads.push(key);
        return inner.get(key);
      },
      set: (key: string, value: string): Promise<void> => inner.set(key, value),
      delete: (key: string): Promise<void> => inner.delete(key),
      listKeys: (prefix?: string): Promise<string[]> => inner.listKeys(prefix),
    },
  };
}

/**
 * Each of these reads its stored credential BEFORE any token resolver runs, so "nothing stored"
 * returns early whether or not another test file has `mock.module`d that resolver in the same
 * process. (`ensureMicrosoftBundleRunning` is deliberately absent: it calls its resolver unguarded
 * — the credential orchestrator is what gates it — so its outcome here would depend on such a
 * mock. It is pinned below through the one path that returns before the resolver.)
 *
 * "Resolves to nothing" alone would pass for a delegator wired to the WRONG connector's spawn, so
 * each run also pins which credentials were consulted: only its own service's.
 */
describe("ensure<Service>Running delegators with no credentials", () => {
  test.each([
    ["ensureWorkdayRunning", "workday"],
    ["ensureZoomRunning", "zoom"],
    ["ensureHubspotRunning", "hubspot"],
    ["ensureMiroRunning", "miro"],
    ["ensureCanvaRunning", "canva"],
    ["ensureFigmaRunning", "figma"],
    ["ensureSalesforceRunning", "salesforce"],
  ] as const)("%s reads only %s credentials and registers no client", async (method, service) => {
    const { vault, reads } = recordingVault();
    mesh = new LazyConnectorMesh(makePaths(), vault);

    await expect(mesh[method]()).resolves.toBeUndefined();

    expect(reads.length).toBeGreaterThan(0);
    expect(reads.filter((key) => !key.startsWith(`${service}.`))).toEqual([]);
    expect(internals(mesh).lazySlots.size).toBe(0);
    expect(mesh.getToolsEpoch()).toBe(0);
  });
});

describe("ensureMicrosoftBundleRunning", () => {
  /**
   * An already-running bundle returns before the Microsoft token resolver is reached, so this
   * path is observable whatever another file has `mock.module`d: the bundle's OWN slot gets its
   * idle disconnect re-armed, and nothing else moves. A delegator wired to another connector's
   * spawner would arm that connector's slot, or read that connector's credential, instead.
   */
  test("re-arms the running bundle's idle disconnect without reading any credential", async () => {
    const { vault, reads } = recordingVault();
    mesh = new LazyConnectorMesh(makePaths(), vault, { inactivityMs: 300_000 });
    const bundle = fakeClient();
    addSlot(mesh, LAZY_MESH.microsoftBundle, bundle);
    // A sibling slot that is also running: its idle timer must stay as it was (unarmed).
    addSlot(mesh, LAZY_MESH.github, fakeClient());

    await expect(mesh.ensureMicrosoftBundleRunning()).resolves.toBeUndefined();

    expect(internals(mesh).lazySlots.get(LAZY_MESH.microsoftBundle)?.idleTimer).toBeDefined();
    expect(internals(mesh).lazySlots.get(LAZY_MESH.github)?.idleTimer).toBeUndefined();
    expect(reads).toEqual([]);
    expect(bundle.disconnectCalls).toBe(0);
    expect([...internals(mesh).lazySlots.keys()].sort((a, b) => a.localeCompare(b))).toEqual([
      LAZY_MESH.github,
      LAZY_MESH.microsoftBundle,
    ]);
    expect(mesh.getToolsEpoch()).toBe(0);
  });
});

describe("the dispatcher tool map", () => {
  test("an allow-list policy drops every connector it does not name; a tool no connector owns is never put to it", async () => {
    const asked: string[] = [];
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      // An ALLOW-list, the shape an org policy takes: whatever it does not name is refused. A tool
      // wrongly put to the policy without an owning connector would therefore be dropped as well,
      // so `fs_read` surviving below proves unowned tools bypass the policy rather than pass it.
      isConnectorAllowed: (serviceId) => {
        asked.push(serviceId);
        return serviceId === "jira" || serviceId === "github_actions";
      },
    });
    internals(mesh).filesystem = fakeClient({ fs_read: tool("file") });
    addSlot(
      mesh,
      LAZY_MESH.github,
      fakeClient({
        github: tool("bare service name"),
        github_list_prs: tool("prs"),
        // A DIFFERENT connector whose id merely starts with "github": attributed to the longest
        // matching id, so the github block must not take it down.
        github_actions_list_runs: tool("runs"),
      }),
    );
    addSlot(mesh, LAZY_MESH.jira, fakeClient({ jira_search: tool("issues") }));
    // A slot whose client was already let go is skipped by the listing, not listed.
    addSlot(mesh, LAZY_MESH.discord, undefined);

    const merged = await mesh.listToolsForDispatcher();

    expect(Object.keys(merged).sort((a, b) => a.localeCompare(b))).toEqual([
      "fs_read",
      "github_actions_list_runs",
      "jira_search",
    ]);
    // Each connector-owned tool is put to the policy exactly once, under its LONGEST matching
    // service id (`github_actions`, not `github`); the filesystem tool never is.
    expect([...asked].sort((a, b) => a.localeCompare(b))).toEqual([
      "github",
      "github",
      "github_actions",
      "jira",
    ]);
  });

  test("listTools passes through an entry with no execute, or no entry at all, without wrapping it", async () => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault());
    internals(mesh).filesystem = fakeClient({
      fs_meta: {},
      // A listing whose value is missing outright: defensive, and must not be invoked.
      fs_gone: undefined as unknown as FakeTools[string],
      fs_read: tool("contents"),
    });

    const merged = await mesh.listTools();

    expect(merged["fs_meta"]).toEqual({});
    expect("fs_gone" in merged).toBe(true);
    expect(merged["fs_gone"]).toBeUndefined();
    // Control: a real tool IS wrapped, in the I11 envelope.
    const out = await merged["fs_read"]?.execute?.({}, undefined);
    expect(out).toBe('<tool_output service="fs" tool="fs_read">"contents"</tool_output>');
  });
});
