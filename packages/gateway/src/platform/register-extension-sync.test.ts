import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import os from "node:os";
import { join } from "node:path";
import pino from "pino";

import {
  insertExtensionRow,
  setExtensionEnabled,
  updateExtensionRowVersion,
} from "../automation/extension-store.ts";
import { createExtensionCredentialsResolver } from "../connectors/extension-sync/extension-identity.ts";
import { getConnectorHealth } from "../connectors/health.ts";
import { dbRun } from "../db/write.ts";
import type { ContinuityEntry } from "../extensions/continuity/continuity-table.ts";
import type { ExtensionManifest } from "../extensions/manifest.ts";
import { isExtensionRuntimeEnabled } from "../extensions/run-grant-env.ts";
import { deleteRunGrant, upsertRunGrant } from "../extensions/run-grant-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import { SyncScheduler } from "../sync/scheduler.ts";
import { unboundSyncCapabilities } from "../sync/sync-capabilities.ts";
import type { Syncable, SyncRuntimeContext } from "../sync/types.ts";
import { createMemoryVault, openMemoryIndexDatabase } from "../testing/bun-test-support.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { bootPolicyFor } from "./demo-boot.ts";
import {
  createExtensionSyncRegistrar,
  createExtensionSyncRegistrarForBoot,
  type ExtensionSyncRegistrarDeps,
  type ExtensionSyncScheduler,
} from "./register-extension-sync.ts";

const KEY = `${"A".repeat(43)}=`;
const OFFICIAL_FP = "fp-official-root";
const EXT_ID = "com.nimbus.readwise";
const CODE_ID = "ext_com_nimbus_readwise";

const READWISE: ContinuityEntry = {
  legacyServiceId: "readwise",
  extensionId: EXT_ID,
  publisherKey: KEY,
  sourceRootFingerprint: OFFICIAL_FP,
  credentials: { token: "readwise.token" },
  expectedPermissions: { network: ["readwise.io"], read: [], write: [] },
  itemTypes: ["highlight", "book"],
};
const TABLE = [READWISE];

function manifest(over: Partial<ExtensionManifest> = {}): ExtensionManifest {
  return {
    id: EXT_ID,
    version: "1.0.0",
    permissions: { network: ["readwise.io"], filesystem: { read: [], write: [] } },
    publisher: { id: "nimbus", key: KEY },
    updateChannel: "stable",
    credentials: { token: { env: "READWISE_TOKEN" } },
    sync: { contract: "1", intervalSeconds: 300, itemTypes: ["highlight", "book"] },
    ...over,
  };
}

const openDbs: Database[] = [];
const scheds: SyncScheduler[] = [];
afterEach(async () => {
  for (const s of scheds.splice(0)) await s.stop();
  for (const db of openDbs.splice(0)) db.close();
});

/** An installed, enabled extension with a live grant; bound to `readwise` unless `fingerprint` differs. */
function seed(opts: { fingerprint?: string | null } = {}): Database {
  const db = openMemoryIndexDatabase();
  openDbs.push(db);
  insertExtensionRow(db, {
    id: EXT_ID,
    version: "1.0.0",
    install_path: join(process.cwd(), "nowhere"),
    manifest_hash: "h",
    entry_hash: "e",
    installed_at: 1,
    last_verified_at: 1,
    tree_digest: "d",
  });
  dbRun(db, "UPDATE extension SET source_root_fingerprint = ? WHERE id = ?", [
    opts.fingerprint === undefined ? OFFICIAL_FP : opts.fingerprint,
    EXT_ID,
  ]);
  approve(db, "1.0.0", "d");
  return db;
}

function approve(db: Database, version: string, digest: string): void {
  upsertRunGrant(db, {
    extension_id: EXT_ID,
    service_id: CODE_ID,
    version,
    tree_digest: digest,
    permissions_json: JSON.stringify({ network: ["readwise.io"], read: [], write: [] }),
    model_access: 0,
    approved_at: 1,
    credentials_json: JSON.stringify({
      token: { env: "READWISE_TOKEN", vaultKey: "readwise.token" },
    }),
  });
}

function runtimeCtx(db: Database, vault: NimbusVault): SyncRuntimeContext {
  return {
    ...unboundSyncCapabilities(),
    db,
    vault,
    logger: pino({ level: "silent" }),
    rateLimiter: new ProviderRateLimiter(),
    sandboxCwd: os.tmpdir(),
    credentialFor: () => ({ credential: "personal" }),
    runTeamList: async () => [],
    depth: "full",
    extensionCredentialsFor: createExtensionCredentialsResolver(db, TABLE, () => manifest()),
  };
}

interface Harness {
  db: Database;
  vault: NimbusVault;
  sched: SyncScheduler;
  egress: Array<{ destination: string; sourceType: string; method: string }>;
  meshCalls: string[];
  confineCalls: string[];
  warnings: unknown[];
  deps: ExtensionSyncRegistrarDeps;
}

function harness(
  db: Database,
  over: Partial<ExtensionSyncRegistrarDeps> = {},
  readManifest: () => ExtensionManifest | undefined = () => manifest(),
): Harness {
  const vault = createMemoryVault();
  const egress: Array<{ destination: string; sourceType: string; method: string }> = [];
  const sched = new SyncScheduler(runtimeCtx(db, vault), undefined, {
    appendSyncEgress: (r) => egress.push(r),
  });
  scheds.push(sched);
  const meshCalls: string[] = [];
  const confineCalls: string[] = [];
  const warnings: unknown[] = [];
  const deps: ExtensionSyncRegistrarDeps = {
    db,
    vault,
    scheduler: sched,
    mesh: {
      callExtensionSyncTool: async (codeServerId) => {
        meshCalls.push(codeServerId);
        return {
          status: "ok",
          items: [{ type: "highlight", externalId: "1", title: "t", modifiedAt: 5, metadata: {} }],
          cursor: null,
          hasMore: false,
        };
      },
    },
    sandbox: {
      canConfine: (p) => {
        confineCalls.push(p.id);
        return null;
      },
    },
    runtimeReadPaths: () => ["/runtime"],
    table: TABLE,
    readManifest,
    logger: { warn: (...a: unknown[]) => warnings.push(a) },
    ...over,
  };
  return { db, vault, sched, egress, meshCalls, confineCalls, warnings, deps };
}

describe("createExtensionSyncRegistrar", () => {
  test("approve registers under the index id", async () => {
    const h = harness(seed());
    await h.vault.set("readwise.token", "tok");
    createExtensionSyncRegistrar(h.deps).refresh(EXT_ID);
    expect(h.sched.syncableFor("readwise")?.serviceId).toBe("readwise");
    expect(h.sched.syncableFor(CODE_ID)).toBeUndefined();
    await h.sched.forceSync("readwise");
    // The mesh is addressed by the CODE-server id; the sandbox question by the spawn policy id.
    expect(h.meshCalls).toEqual([CODE_ID]);
    expect(h.confineCalls).toEqual([`ext.${CODE_ID}`]);
    expect(h.egress).toEqual([{ destination: "readwise", sourceType: "sync", method: "sync.run" }]);
    expect(new LocalIndex(h.db).search({ service: "readwise" })).toHaveLength(1);
  });

  test("an unbound extension registers under its own ext_ id", () => {
    const h = harness(seed({ fingerprint: null }));
    createExtensionSyncRegistrar(h.deps).refresh(EXT_ID);
    expect(h.sched.syncableFor(CODE_ID)?.serviceId).toBe(CODE_ID);
    expect(h.sched.syncableFor("readwise")).toBeUndefined();
  });

  test("a manifest without a sync block registers nothing", () => {
    const { sync: _unused, ...noSync } = manifest();
    const h = harness(seed(), {}, () => noSync);
    createExtensionSyncRegistrar(h.deps).refresh(EXT_ID);
    expect(h.sched.syncableFor("readwise")).toBeUndefined();
  });

  test("boot registers every live grant from the database", () => {
    const h = harness(seed());
    createExtensionSyncRegistrar(h.deps).registerAllFromDatabase();
    expect(h.sched.syncableFor("readwise")).toBeDefined();
  });

  test("unregister mid-run: exactly one page call, nothing written after it", async () => {
    let release: (v: unknown) => void = () => {};
    let entered: () => void = () => {};
    const enteredP = new Promise<void>((r) => {
      entered = r;
    });
    let calls = 0;
    const h = harness(seed(), {
      mesh: {
        callExtensionSyncTool: async () => {
          calls += 1;
          entered();
          return new Promise((r) => {
            release = r;
          });
        },
      },
    });
    await h.vault.set("readwise.token", "tok");
    const r = createExtensionSyncRegistrar(h.deps);
    r.refresh(EXT_ID);
    const forced = h.sched.forceSync("readwise").then(
      () => "resolved",
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    await enteredP;
    r.unregister(EXT_ID);
    // A non-empty page that asks for more: without the liveness checks it would be written and a
    // second call (a re-spawn, mid-remove) would follow.
    release({
      status: "ok",
      items: [{ type: "highlight", externalId: "1", title: "t", modifiedAt: 5, metadata: {} }],
      cursor: "c2",
      hasMore: true,
    });
    expect(await forced).toBe("Connector removed");
    await new Promise((res) => setTimeout(res, 0));
    expect(calls).toBe(1);
    expect(new LocalIndex(h.db).search({ service: "readwise" })).toHaveLength(0);
  });

  test("a tool-only extension whose update leaves the grant stale is not paused", () => {
    const { sync: _unusedSync, ...noSync } = manifest();
    const h = harness(seed(), {}, () => noSync);
    updateExtensionRowVersion(h.db, EXT_ID, "1.1.0", "h2", "e2", 2, "d2");
    createExtensionSyncRegistrar(h.deps).refresh(EXT_ID);
    expect(getConnectorHealth(h.db, "readwise").state).not.toBe("paused");
    expect(getConnectorHealth(h.db, CODE_ID).state).not.toBe("paused");
    const row = h.db
      .query("SELECT COUNT(*) AS c FROM sync_state WHERE connector_id IN (?, ?)")
      .get("readwise", CODE_ID) as { c: number };
    expect(row.c).toBe(0);
  });

  test("disable then enable re-registers", () => {
    const h = harness(seed());
    const r = createExtensionSyncRegistrar(h.deps);
    r.refresh(EXT_ID);
    setExtensionEnabled(h.db, EXT_ID, false);
    r.refresh(EXT_ID);
    expect(h.sched.syncableFor("readwise")).toBeUndefined();
    setExtensionEnabled(h.db, EXT_ID, true);
    r.refresh(EXT_ID);
    expect(h.sched.syncableFor("readwise")).toBeDefined();
  });

  test("revoke keeps items", () => {
    const h = harness(seed());
    const idx = new LocalIndex(h.db);
    idx.upsert({ id: "1", service: "readwise", itemType: "highlight", name: "kept" });
    const r = createExtensionSyncRegistrar(h.deps);
    r.refresh(EXT_ID);
    deleteRunGrant(h.db, EXT_ID);
    r.refresh(EXT_ID);
    expect(h.sched.syncableFor("readwise")).toBeUndefined();
    expect(idx.search({ service: "readwise" })).toHaveLength(1);
  });

  test("applied update pauses with the re-approve reason", () => {
    const h = harness(seed());
    const r = createExtensionSyncRegistrar(h.deps);
    r.refresh(EXT_ID);
    updateExtensionRowVersion(h.db, EXT_ID, "1.1.0", "h2", "e2", 2, "d2");
    r.refresh(EXT_ID);
    expect(h.sched.syncableFor("readwise")).toBeUndefined();
    const health = getConnectorHealth(h.db, "readwise");
    expect(health.state).toBe("paused");
    expect(health.lastError).toBe(
      `updated to 1.1.0 — run \`nimbus extension approve ${EXT_ID}\` to resume sync`,
    );
    // Re-approval over the new code registers it again AND lifts exactly that pause.
    approve(h.db, "1.1.0", "d2");
    r.refresh(EXT_ID);
    expect(h.sched.syncableFor("readwise")).toBeDefined();
    expect(getConnectorHealth(h.db, "readwise").state).not.toBe("paused");
  });

  test("a pause the owner set is not lifted by a re-approval", () => {
    const h = harness(seed());
    const r = createExtensionSyncRegistrar(h.deps);
    h.sched.pause("readwise");
    r.refresh(EXT_ID);
    expect(h.sched.syncableFor("readwise")).toBeDefined();
    expect(getConnectorHealth(h.db, "readwise").state).toBe("paused");
  });

  test("a stale grant at boot is skipped without re-pausing", () => {
    const h = harness(seed());
    updateExtensionRowVersion(h.db, EXT_ID, "1.1.0", "h2", "e2", 2, "d2");
    createExtensionSyncRegistrar(h.deps).registerAllFromDatabase();
    expect(h.sched.syncableFor("readwise")).toBeUndefined();
    expect(getConnectorHealth(h.db, "readwise").state).not.toBe("paused");
  });

  test("blank token after approval: no spawn, no egress row", async () => {
    const h = harness(seed());
    await h.vault.set("readwise.token", "   ");
    createExtensionSyncRegistrar(h.deps).refresh(EXT_ID);
    await h.sched.forceSync("readwise");
    expect(h.meshCalls).toEqual([]);
    expect(h.egress).toEqual([]);
    expect(new LocalIndex(h.db).search({ service: "readwise" })).toHaveLength(0);
  });

  test("a sandbox that cannot confine pauses with the reason and never spawns", async () => {
    const h = harness(seed(), { sandbox: { canConfine: () => "helper missing" } });
    await h.vault.set("readwise.token", "tok");
    createExtensionSyncRegistrar(h.deps).refresh(EXT_ID);
    await h.sched.forceSync("readwise").catch(() => undefined);
    expect(h.meshCalls).toEqual([]);
    expect(h.egress).toEqual([]);
    expect(getConnectorHealth(h.db, "readwise").lastError).toContain("helper missing");
  });

  test("a built-in syncable under the same index id is not replaced", () => {
    const h = harness(seed());
    const builtIn: Syncable = {
      serviceId: "readwise",
      defaultIntervalMs: 60_000,
      initialSyncDepthDays: 30,
      sync: async () => ({
        cursor: null,
        itemsUpserted: 0,
        itemsDeleted: 0,
        hasMore: false,
        durationMs: 0,
      }),
    };
    h.sched.register(builtIn);
    const r = createExtensionSyncRegistrar(h.deps);
    r.refresh(EXT_ID);
    expect(h.sched.syncableFor("readwise")).toBe(builtIn);
    expect(h.warnings).toHaveLength(1);
    // And unregistering the extension never removes the built-in it did not register.
    r.unregister(EXT_ID);
    setExtensionEnabled(h.db, EXT_ID, false);
    r.refresh(EXT_ID);
    expect(h.sched.syncableFor("readwise")).toBe(builtIn);
  });

  test("a policy-blocked id is not tracked, so a later unregister touches nothing", () => {
    const db = seed();
    const base = harness(db);
    const blocked: ExtensionSyncScheduler = {
      register: () => {},
      unregister: (id) => base.sched.unregister(id),
      pause: (id, reason) => base.sched.pause(id, reason),
      resume: (id) => base.sched.resume(id),
      syncableFor: (id) => base.sched.syncableFor(id),
    };
    const r = createExtensionSyncRegistrar({ ...base.deps, scheduler: blocked });
    r.refresh(EXT_ID);
    expect(base.sched.syncableFor("readwise")).toBeUndefined();
    r.unregister(EXT_ID);
  });
});

describe("createExtensionSyncRegistrarForBoot", () => {
  test("demo-rooted gateway registers nothing", () => {
    const db = seed();
    const base = harness(db);
    const registered: string[] = [];
    const spy: ExtensionSyncScheduler = {
      register: (c) => registered.push(c.serviceId),
      unregister: () => {},
      pause: () => {},
      resume: () => {},
      syncableFor: () => undefined,
    };
    const demo = { demo: true } as const;
    const r = createExtensionSyncRegistrarForBoot(
      {
        runtimeEnabled: isExtensionRuntimeEnabled({ runtime: true }, demo),
        syncEnabled: bootPolicyFor(demo).syncScheduler,
      },
      { ...base.deps, scheduler: spy },
    );
    r.registerAllFromDatabase();
    r.refresh(EXT_ID);
    expect(registered).toEqual([]);
  });

  test("runtime off registers nothing; runtime on and sync on registers", () => {
    const db = seed();
    const base = harness(db);
    const registered: string[] = [];
    const spy: ExtensionSyncScheduler = {
      register: (c) => registered.push(c.serviceId),
      unregister: () => {},
      pause: () => {},
      resume: () => {},
      syncableFor: () => undefined,
    };
    createExtensionSyncRegistrarForBoot(
      { runtimeEnabled: false, syncEnabled: true },
      { ...base.deps, scheduler: spy },
    ).registerAllFromDatabase();
    expect(registered).toEqual([]);
    createExtensionSyncRegistrarForBoot(
      { runtimeEnabled: true, syncEnabled: true },
      { ...base.deps, scheduler: spy },
    ).registerAllFromDatabase();
    expect(registered).toEqual(["readwise"]);
  });
});
