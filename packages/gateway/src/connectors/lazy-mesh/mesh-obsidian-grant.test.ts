/**
 * Phase 9.7 B4b (I15): the mesh side of the Obsidian write grant. The Windows revoke before every
 * Obsidian spawn and after an opt-in change, its fail-closed refusal, the serial queue that keeps a
 * restart's stop after any spawn decision begun before it, the enable-prompt scope, and Obsidian's
 * tools in the dispatcher listing. The revoker is injected (no helper process); the spawned
 * `MCPClient` is real but never connected, so nothing is started.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MCPClient } from "@mastra/mcp";

import type { PlatformPaths } from "../../platform/paths.ts";
import type { AppContainerGrantRevoker } from "../../platform/sandbox/win32-grant-revoke.ts";
import { createMockVault } from "../../vault/mock.ts";
import { LazyDrainTracker } from "./drain.ts";
import { LAZY_MESH } from "./keys.ts";
import { LazyConnectorMesh } from "./mesh.ts";
import {
  fileObsidianGrantLedger,
  type ObsidianGrantLedgerStore,
  obsidianGrantLedgerFile,
} from "./obsidian-grant-ledger.ts";
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

/** An in-memory ledger that counts its saves. */
function memoryLedger(initial: readonly string[]): ObsidianGrantLedgerStore & { saves: number } {
  let paths = [...initial];
  const store = {
    saves: 0,
    load: () => [...paths],
    save: (next: readonly string[]) => {
      store.saves += 1;
      paths = [...next];
    },
  };
  return store;
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

describe("the Obsidian pre-spawn revoke (Windows) and its ledger", () => {
  test("grant off and an empty ledger: no revoke, no helper run, the spawn proceeds", async () => {
    const t = tree();
    const revokes: Revokes = [];
    const m = new LazyConnectorMesh(makePaths(t.base), createMockVault(), {
      obsidianVaultPaths: [t.root],
      obsidianWriteGrantEnabled: () => false,
      obsidianGrantRevoker: fakeRevoker(true, revokes),
    });
    mesh = m;
    await m.ensureObsidianRunning();
    expect(revokes).toEqual([]);
    expect(obsidianClient(m)).toBeDefined();
  });

  test("grant on: the vaults are revoked and recorded in the ledger BEFORE the client exists", async () => {
    const t = tree();
    const paths = makePaths(t.base);
    const revokes: Revokes = [];
    let clientAtRevoke: MCPClient | undefined;
    let ledgerAtRevoke: readonly string[] = ["unset"];
    const ledger = fileObsidianGrantLedger(obsidianGrantLedgerFile(paths.configDir));
    const m = new LazyConnectorMesh(paths, createMockVault(), {
      obsidianVaultPaths: [t.root],
      obsidianWriteGrantEnabled: () => true,
      obsidianGrantRevoker: {
        active: true,
        revoke: (p) => {
          clientAtRevoke = obsidianClient(m);
          ledgerAtRevoke = ledger.load();
          revokes.push([...p]);
          return Promise.resolve();
        },
      },
    });
    mesh = m;
    await m.ensureObsidianRunning();
    // The root is never revoked as a read root; only the vault it holds.
    expect(revokes).toEqual([[t.vault]]);
    expect(clientAtRevoke).toBeUndefined();
    expect(ledgerAtRevoke).toEqual([]);
    expect(ledger.load()).toEqual([t.vault]);
    expect(obsidianClient(m)).toBeDefined();
  });

  test("the ledger survives a gateway restart: a vault no longer discovered is still revoked", async () => {
    const t = tree();
    const paths = makePaths(t.base);
    const first = new LazyConnectorMesh(paths, createMockVault(), {
      obsidianVaultPaths: [t.root],
      obsidianWriteGrantEnabled: () => true,
      obsidianGrantRevoker: fakeRevoker(true, []),
    });
    await first.ensureObsidianRunning();
    await first.disconnect();
    // The vault stops being a vault (its .obsidian is gone) while the gateway is down.
    rmSync(join(t.vault, ".obsidian"), { recursive: true, force: true });
    const revokes: Revokes = [];
    const m = new LazyConnectorMesh(paths, createMockVault(), {
      obsidianVaultPaths: [t.root],
      obsidianWriteGrantEnabled: () => false,
      obsidianGrantRevoker: fakeRevoker(true, revokes),
    });
    mesh = m;
    await m.ensureObsidianRunning();
    expect(revokes).toEqual([[t.vault]]);
    const ledger = fileObsidianGrantLedger(obsidianGrantLedgerFile(paths.configDir));
    expect(ledger.load()).toEqual([]);
  });

  test("a failed revoke refuses the spawn, keeps the ledger, and is logged once per failing streak", async () => {
    const t = tree();
    const revokes: Revokes = [];
    let fail = true;
    const w = warnings();
    const store = memoryLedger([join(t.base, "old-vault")]);
    const m = new LazyConnectorMesh(makePaths(t.base), createMockVault(), {
      obsidianVaultPaths: [t.root],
      logger: w.logger,
      obsidianGrantLedger: store,
      obsidianGrantRevoker: fakeRevoker(true, revokes, () =>
        fail ? Promise.reject(new Error("helper exit 1")) : Promise.resolve(),
      ),
    });
    mesh = m;
    await m.ensureObsidianRunning();
    await m.ensureObsidianRunning();
    expect(obsidianClient(m)).toBeUndefined();
    expect(revokes).toHaveLength(2);
    expect(store.load()).toEqual([join(t.base, "old-vault")]);
    expect(w.msgs.filter((x) => x.includes("could not be revoked"))).toHaveLength(1);
    fail = false;
    await m.ensureObsidianRunning();
    expect(obsidianClient(m)).toBeDefined();
    expect(store.load()).toEqual([]);
  });

  test("an unreadable ledger refuses the spawn (fail closed)", async () => {
    const t = tree();
    const paths = makePaths(t.base);
    const file = obsidianGrantLedgerFile(paths.configDir);
    mkdirSync(join(paths.configDir, "sandbox-grants"), { recursive: true });
    writeFileSync(file, "{not json");
    const revokes: Revokes = [];
    const m = new LazyConnectorMesh(paths, createMockVault(), {
      obsidianVaultPaths: [t.root],
      obsidianGrantRevoker: fakeRevoker(true, revokes),
    });
    mesh = m;
    await m.ensureObsidianRunning();
    expect(obsidianClient(m)).toBeUndefined();
    expect(revokes).toEqual([]);
  });

  test("a skipped vault is revoked canonicalised; a home-or-root skip never is", async () => {
    const t = tree();
    const nested = join(t.vault, "inner");
    mkdirSync(join(nested, ".obsidian"), { recursive: true });
    const revokes: Revokes = [];
    const m = new LazyConnectorMesh(makePaths(t.base), createMockVault(), {
      obsidianVaultPaths: [t.root, t.base],
      obsidianWriteGrantEnabled: () => true,
      obsidianGrantRevoker: fakeRevoker(true, revokes),
      obsidianWriteGrantDeps: {
        discoverVaults: () => [t.vault, nested, t.base],
        realpath: (p) => realpathSync.native(p),
        homeDir: t.base,
        protectedRoots: [],
        platform: process.platform,
      },
    });
    mesh = m;
    await m.ensureObsidianRunning();
    expect(revokes).toEqual([[t.vault, nested]]);
  });

  test("off Windows the revoker is inert: never called, no ledger written, the spawn proceeds", async () => {
    const t = tree();
    const revokes: Revokes = [];
    const store = memoryLedger([]);
    const m = new LazyConnectorMesh(makePaths(t.base), createMockVault(), {
      obsidianVaultPaths: [t.root],
      obsidianWriteGrantEnabled: () => true,
      obsidianGrantRevoker: fakeRevoker(false, revokes),
      obsidianGrantLedger: store,
    });
    mesh = m;
    await m.ensureObsidianRunning();
    await m.restartObsidian();
    expect(revokes).toEqual([]);
    expect(store.saves).toBe(0);
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
  test("detaches the slot at once and revokes what the ledger names", async () => {
    const t = tree();
    const revokes: Revokes = [];
    let approved = true;
    const m = new LazyConnectorMesh(makePaths(t.base), createMockVault(), {
      obsidianVaultPaths: [t.root],
      obsidianWriteGrantEnabled: () => approved,
      obsidianGrantRevoker: fakeRevoker(true, revokes),
    });
    mesh = m;
    await m.ensureObsidianRunning();
    const first = obsidianClient(m);
    expect(first).toBeDefined();
    approved = false;
    await m.restartObsidian();
    expect(obsidianClient(m)).toBeUndefined();
    expect(revokes).toEqual([[t.vault], [t.vault]]);
    await m.ensureObsidianRunning();
    expect(obsidianClient(m)).not.toBe(first);
    // The ledger is empty and the grant off: the respawn ran no helper.
    expect(revokes).toHaveLength(2);
  });

  test("an in-flight call does not hold the restart, a listing, or the next spawn; the old client disconnects after it", async () => {
    const t = tree();
    const m = new LazyConnectorMesh(makePaths(t.base), createMockVault(), {
      obsidianVaultPaths: [t.root],
      obsidianGrantRevoker: fakeRevoker(true, []),
    });
    mesh = m;
    let disconnected = false;
    const drain = new LazyDrainTracker();
    internals(m).lazySlots.set(LAZY_MESH.obsidian, {
      client: {
        listTools: () => Promise.resolve({}),
        disconnect: () => {
          disconnected = true;
          return Promise.resolve();
        },
      } as unknown as MCPClient,
      idleTimer: undefined,
      drain,
    });
    drain.bump(); // a call in flight on the old child
    const epoch = m.getToolsEpoch();
    const t0 = Date.now();
    await m.restartObsidian();
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(obsidianClient(m)).toBeUndefined();
    expect(m.getToolsEpoch()).toBeGreaterThan(epoch);
    // A new spawn is not blocked by the old drain, and gets a fresh drain tracker.
    await m.ensureObsidianRunning();
    expect(obsidianClient(m)).toBeDefined();
    expect(internals(m).lazySlots.get(LAZY_MESH.obsidian)?.drain).not.toBe(drain);
    expect(disconnected).toBe(false);
    drain.drop();
    for (let i = 0; i < 10 && !disconnected; i++) await Promise.resolve();
    expect(disconnected).toBe(true);
  });

  test("never rejects: a failed revoke is logged", async () => {
    const t = tree();
    const w = warnings();
    const m = new LazyConnectorMesh(makePaths(t.base), createMockVault(), {
      obsidianVaultPaths: [t.root],
      logger: w.logger,
      obsidianGrantLedger: memoryLedger([t.vault]),
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
