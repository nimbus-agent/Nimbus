/**
 * Phase 9.7 B4b (I15): the mesh side of the Obsidian write grant. The Windows revoke before every
 * Obsidian spawn and after an opt-in change, its fail-closed refusal, the serial queue that keeps a
 * restart's stop after any spawn decision begun before it, the enable-prompt scope, and Obsidian's
 * tools in the dispatcher listing. The revoker is injected (no helper process); the spawned
 * `MCPClient` is real but never connected, so nothing is started.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MCPClient } from "@mastra/mcp";

import type { PlatformPaths } from "../../platform/paths.ts";
import type { AppContainerGrantRevoker } from "../../platform/sandbox/win32-grant-revoke.ts";
import { createMockVault } from "../../vault/mock.ts";
import { LazyDrainTracker } from "./drain.ts";
import { LAZY_MESH } from "./keys.ts";
import { LazyConnectorMesh } from "./mesh.ts";
import type { LazyMcpSlot, MeshLogger } from "./slot.ts";

const temps: string[] = [];
let mesh: LazyConnectorMesh | undefined;

function tempBase(): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), "nimbus-mesh-obs-")));
  temps.push(d);
  return d;
}

function makePaths(base: string): PlatformPaths {
  return {
    configDir: join(base, "nimbus", "config"),
    dataDir: join(base, "nimbus", "data"),
    logDir: join(base, "nimbus", "log"),
    socketPath: join(base, "nimbus", "sock"),
    extensionsDir: join(base, "nimbus", "ext"),
    tempDir: join(base, "nimbus", "tmp"),
    sandboxDir: join(base, "nimbus", "sandbox"),
  };
}

afterEach(async () => {
  if (mesh !== undefined) await mesh.disconnect();
  mesh = undefined;
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A tree with one root holding one vault, plus a plain folder. */
function tree(): { base: string; root: string; vault: string } {
  const base = tempBase();
  const root = join(base, "notes");
  const vault = join(root, "vaultA");
  mkdirSync(join(vault, ".obsidian"), { recursive: true });
  mkdirSync(join(root, "plain"));
  return { base, root, vault };
}

type Revokes = string[][];

function fakeRevoker(
  active: boolean,
  revokes: Revokes,
  outcome: () => Promise<void> = () => Promise.resolve(),
): AppContainerGrantRevoker {
  return {
    active,
    revoke: (paths) => {
      revokes.push([...paths]);
      return outcome();
    },
  };
}

function warnings(): { logger: MeshLogger; msgs: string[] } {
  const msgs: string[] = [];
  return { msgs, logger: { warn: (_b, msg) => msgs.push(msg ?? "") } };
}

function internals(m: LazyConnectorMesh): {
  lazySlots: Map<string, LazyMcpSlot>;
  filesystem: unknown;
} {
  return m as unknown as { lazySlots: Map<string, LazyMcpSlot>; filesystem: unknown };
}

function obsidianClient(m: LazyConnectorMesh): MCPClient | undefined {
  return internals(m).lazySlots.get(LAZY_MESH.obsidian)?.client;
}

describe("the Obsidian pre-spawn revoke (Windows)", () => {
  test("revokes the canonical roots and every vault the grant would keep, BEFORE the client exists", async () => {
    const t = tree();
    const revokes: Revokes = [];
    let clientAtRevoke: MCPClient | undefined;
    const m = new LazyConnectorMesh(makePaths(t.base), createMockVault(), {
      obsidianVaultPaths: [t.root],
      obsidianWriteGrantEnabled: () => false,
      obsidianGrantRevoker: {
        active: true,
        revoke: (paths) => {
          clientAtRevoke = obsidianClient(m);
          revokes.push([...paths]);
          return Promise.resolve();
        },
      },
    });
    mesh = m;
    await m.ensureObsidianRunning();
    // The grant is OFF, yet the vault is revoked: a write ACE left by an earlier approval must go.
    expect(revokes).toEqual([[t.root, t.vault]]);
    expect(clientAtRevoke).toBeUndefined();
    expect(obsidianClient(m)).toBeDefined();
  });

  test("a failed revoke refuses the spawn and is logged once per failing streak", async () => {
    const t = tree();
    const revokes: Revokes = [];
    let fail = true;
    const w = warnings();
    const m = new LazyConnectorMesh(makePaths(t.base), createMockVault(), {
      obsidianVaultPaths: [t.root],
      logger: w.logger,
      obsidianGrantRevoker: fakeRevoker(true, revokes, () =>
        fail ? Promise.reject(new Error("helper exit 1")) : Promise.resolve(),
      ),
    });
    mesh = m;
    await m.ensureObsidianRunning();
    await m.ensureObsidianRunning();
    expect(obsidianClient(m)).toBeUndefined();
    expect(revokes).toHaveLength(2);
    expect(w.msgs.filter((x) => x.includes("could not be revoked"))).toHaveLength(1);
    fail = false;
    await m.ensureObsidianRunning();
    expect(obsidianClient(m)).toBeDefined();
  });

  test("the last spawn's write list is revoked again before the next spawn", async () => {
    const t = tree();
    const revokes: Revokes = [];
    let approved = true;
    const m = new LazyConnectorMesh(makePaths(t.base), createMockVault(), {
      obsidianVaultPaths: [t.root],
      obsidianWriteGrantEnabled: () => approved,
      obsidianGrantRevoker: fakeRevoker(true, revokes),
      // The vault disappears from discovery after the first spawn: only the memory names it.
      obsidianWriteGrantDeps: {
        discoverVaults: () => (revokes.length === 0 ? [t.vault] : []),
        realpath: (p) => realpathSync.native(p),
        homeDir: join(t.base, "home"),
        protectedRoots: [],
        platform: process.platform,
      },
    });
    mesh = m;
    await m.ensureObsidianRunning();
    approved = false;
    await m.restartObsidian();
    await m.ensureObsidianRunning();
    expect(revokes[0]).toEqual([t.root, t.vault]);
    // The restart's revoke still names the vault the first spawn was granted.
    expect(revokes[1]).toEqual([t.root, t.vault]);
    expect(revokes[2]).toEqual([t.root]);
  });

  test("off Windows the revoker is inert: never called, and the spawn proceeds", async () => {
    const t = tree();
    const revokes: Revokes = [];
    const m = new LazyConnectorMesh(makePaths(t.base), createMockVault(), {
      obsidianVaultPaths: [t.root],
      obsidianWriteGrantEnabled: () => true,
      obsidianGrantRevoker: fakeRevoker(false, revokes),
    });
    mesh = m;
    await m.ensureObsidianRunning();
    await m.restartObsidian();
    expect(revokes).toEqual([]);
  });

  test("the production revoker follows the platform option: inert on linux", async () => {
    const t = tree();
    const m = new LazyConnectorMesh(makePaths(t.base), createMockVault(), {
      obsidianVaultPaths: [t.root],
      platform: "linux",
    });
    mesh = m;
    await m.ensureObsidianRunning();
    expect(obsidianClient(m)).toBeDefined();
  });
});

describe("restartObsidian", () => {
  test("stops the Obsidian slot so the next spawn reads the new grant, then revokes", async () => {
    const t = tree();
    const revokes: Revokes = [];
    const m = new LazyConnectorMesh(makePaths(t.base), createMockVault(), {
      obsidianVaultPaths: [t.root],
      obsidianGrantRevoker: fakeRevoker(true, revokes),
    });
    mesh = m;
    await m.ensureObsidianRunning();
    const first = obsidianClient(m);
    expect(first).toBeDefined();
    await m.restartObsidian();
    expect(obsidianClient(m)).toBeUndefined();
    expect(revokes).toHaveLength(2);
    await m.ensureObsidianRunning();
    expect(obsidianClient(m)).not.toBe(first);
  });

  test("never rejects: a failed revoke is logged", async () => {
    const t = tree();
    const w = warnings();
    const m = new LazyConnectorMesh(makePaths(t.base), createMockVault(), {
      obsidianVaultPaths: [t.root],
      logger: w.logger,
      obsidianGrantRevoker: fakeRevoker(true, [], () => Promise.reject(new Error("exit 1"))),
    });
    mesh = m;
    await m.restartObsidian();
    expect(w.msgs).toEqual(["obsidian sandbox grants not revoked after the opt-in changed"]);
  });

  test("a spawn decision begun before a restart cannot leave a client after it (serial queue)", async () => {
    const t = tree();
    const gate = Promise.withResolvers<void>();
    let calls = 0;
    const m = new LazyConnectorMesh(makePaths(t.base), createMockVault(), {
      obsidianVaultPaths: [t.root],
      obsidianWriteGrantEnabled: () => true,
      obsidianGrantRevoker: {
        active: true,
        revoke: () => {
          calls += 1;
          // The first revoke (the spawn's) is held until the restart has been requested.
          return calls === 1 ? gate.promise : Promise.resolve();
        },
      },
    });
    mesh = m;
    const spawning = m.ensureObsidianRunning();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const restarting = m.restartObsidian();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    // The restart waits for the spawn decision; it has not revoked yet.
    expect(calls).toBe(1);
    gate.resolve();
    await Promise.all([spawning, restarting]);
    expect(calls).toBe(2);
    expect(obsidianClient(m)).toBeUndefined();
  });
});

describe("obsidianWriteScope (the enable prompt's preview)", () => {
  test("names the roots as configured, the vaults kept and each skipped vault", () => {
    const t = tree();
    const nested = join(t.vault, "inner");
    mkdirSync(join(nested, ".obsidian"), { recursive: true });
    const m = new LazyConnectorMesh(makePaths(t.base), createMockVault(), {
      obsidianVaultPaths: [t.root],
    });
    mesh = m;
    expect(m.obsidianWriteScope()).toEqual({
      roots: [t.root],
      vaults: [t.vault],
      skipped: [{ path: nested, reason: "nested" }],
    });
  });

  test("a vault inside a protected Nimbus directory is skipped by the production rule", () => {
    const base = tempBase();
    const paths = makePaths(base);
    const vault = join(paths.extensionsDir, "v");
    mkdirSync(join(vault, ".obsidian"), { recursive: true });
    const m = new LazyConnectorMesh(paths, createMockVault(), {
      obsidianVaultPaths: [join(base, "nimbus")],
    });
    mesh = m;
    expect(m.obsidianWriteScope()).toEqual({
      roots: [join(base, "nimbus")],
      vaults: [],
      skipped: [{ path: vault, reason: "protected" }],
    });
  });

  test("no roots: nothing", () => {
    const m = new LazyConnectorMesh(makePaths(tempBase()), createMockVault());
    mesh = m;
    expect(m.obsidianWriteScope()).toEqual({ roots: [], vaults: [], skipped: [] });
  });
});

describe("the dispatcher listing includes Obsidian (review fix 4)", () => {
  function fakeClient(tools: Record<string, unknown>): MCPClient {
    return {
      listTools: () => Promise.resolve(tools),
      disconnect: () => Promise.resolve(),
    } as unknown as MCPClient;
  }

  test("a live Obsidian slot's tools are in the merged map, after the filesystem spawn gate", async () => {
    const gate = Promise.withResolvers<void>();
    const m = new LazyConnectorMesh(makePaths(tempBase()), createMockVault(), {
      filesystemSpawnGate: gate.promise,
    });
    mesh = m;
    let obsidianListings = 0;
    internals(m).filesystem = fakeClient({});
    internals(m).lazySlots.set(LAZY_MESH.obsidian, {
      client: {
        listTools: () => {
          obsidianListings += 1;
          return Promise.resolve({
            obsidian_obsidian_append_to_daily_note: { execute: async () => "ok" },
          });
        },
        disconnect: () => Promise.resolve(),
      } as unknown as MCPClient,
      idleTimer: undefined,
      drain: new LazyDrainTracker(),
    });
    const pending = m.listToolsForDispatcher();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(obsidianListings).toBe(0);
    gate.resolve();
    const merged = await pending;
    expect(Object.keys(merged)).toContain("obsidian_obsidian_append_to_daily_note");
  });
});
