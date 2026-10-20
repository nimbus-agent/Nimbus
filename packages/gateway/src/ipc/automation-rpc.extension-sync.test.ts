import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { insertExtensionRow } from "../automation/extension-store.ts";
import { transitionHealth } from "../connectors/health.ts";
import { dbRun } from "../db/write.ts";
import type { ContinuityEntry } from "../extensions/continuity/continuity-table.ts";
import type { ExtensionRunGrantEnv } from "../extensions/extension-run-grants.ts";
import type { ExtensionManifest } from "../extensions/manifest.ts";
import { getRunGrant, upsertRunGrant } from "../extensions/run-grant-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { purgeExtensionIndexData } from "../platform/register-extension-sync.ts";
import { createMemoryVault } from "../testing/bun-test-support.ts";
import { type AutomationRpcExtensionSyncHandle, dispatchAutomationRpc } from "./automation-rpc.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

function tempRoot(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "nimbus-rpc-ext-sync-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  cleanups.push(() => db.close());
  return db;
}

/** A spy handle: records every hook, and whether the grant still existed when purge ran. */
function spyHandle(
  db: Database,
  id: string,
): {
  handle: AutomationRpcExtensionSyncHandle;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    handle: {
      refresh: (x) => calls.push(`refresh:${x}`),
      unregister: (x) => calls.push(`unregister:${x}`),
      purgeBeforeRemove: async (x) => {
        calls.push(`purge:${x}:grant=${String(getRunGrant(db, id) !== null)}`);
      },
    },
  };
}

describe("extension.* handlers drive the extension sync host", () => {
  async function installedAndApproved(): Promise<{ db: Database; env: ExtensionRunGrantEnv }> {
    const root = tempRoot();
    const db = freshDb();
    const src = join(root, "src");
    mkdirSync(join(src, "dist"), { recursive: true });
    writeFileSync(
      join(src, "nimbus.extension.json"),
      JSON.stringify({ id: "rpc.sync", version: "1.0.0", entry: "dist/index.js" }),
    );
    writeFileSync(join(src, "dist", "index.js"), "export {};\n");
    await dispatchAutomationRpc({
      method: "extension.install",
      params: { sourcePath: src },
      db,
      extensionsDir: join(root, "data", "extensions"),
      ownerGate: async () => true,
    });
    const env: ExtensionRunGrantEnv = {
      platform: process.platform,
      protectedRoots: [join(root, "data")],
      runtimeReadPaths: [],
      realpath: (p) => realpathSync.native(p),
    };
    return { db, env };
  }

  test("approveRun, disable, enable and revokeRun each refresh it", async () => {
    const { db, env } = await installedAndApproved();
    const { handle, calls } = spyHandle(db, "rpc.sync");
    const common = { db, extensionSync: handle };
    await dispatchAutomationRpc({
      ...common,
      method: "extension.approveRun",
      params: { id: "rpc.sync" },
      runGrantEnv: env,
      ownerGate: async () => true,
    });
    await dispatchAutomationRpc({
      ...common,
      method: "extension.disable",
      params: { id: "rpc.sync" },
    });
    await dispatchAutomationRpc({
      ...common,
      method: "extension.enable",
      params: { id: "rpc.sync" },
    });
    await dispatchAutomationRpc({
      ...common,
      method: "extension.revokeRun",
      params: { id: "rpc.sync" },
    });
    expect(calls).toEqual([
      "refresh:rpc.sync",
      "refresh:rpc.sync",
      "refresh:rpc.sync",
      "refresh:rpc.sync",
    ]);
  });

  test("a denied approval refreshes nothing", async () => {
    const { db, env } = await installedAndApproved();
    const { handle, calls } = spyHandle(db, "rpc.sync");
    await dispatchAutomationRpc({
      db,
      extensionSync: handle,
      method: "extension.approveRun",
      params: { id: "rpc.sync" },
      runGrantEnv: env,
      ownerGate: async () => false,
    }).catch(() => undefined);
    expect(calls).toEqual([]);
  });

  test("remove unregisters, then purges while the grant still exists, before deleting the row", async () => {
    const { db, env } = await installedAndApproved();
    await dispatchAutomationRpc({
      db,
      method: "extension.approveRun",
      params: { id: "rpc.sync" },
      runGrantEnv: env,
      ownerGate: async () => true,
    });
    const { handle, calls } = spyHandle(db, "rpc.sync");
    await dispatchAutomationRpc({
      db,
      extensionSync: handle,
      method: "extension.remove",
      params: { id: "rpc.sync" },
    });
    expect(calls).toEqual(["unregister:rpc.sync", "purge:rpc.sync:grant=true"]);
    expect(getRunGrant(db, "rpc.sync")).toBeNull();
  });
});

const KEY = `${"A".repeat(43)}=`;
const OFFICIAL_FP = "fp-official-root";
const EXT_ID = "com.nimbus.readwise";
const CODE_ID = "ext_com_nimbus_readwise";
const TABLE: ContinuityEntry[] = [
  {
    legacyServiceId: "readwise",
    extensionId: EXT_ID,
    publisherKey: KEY,
    sourceRootFingerprint: OFFICIAL_FP,
    credentials: { token: "readwise.token" },
    expectedPermissions: { network: ["readwise.io"], read: [], write: [] },
    itemTypes: ["highlight", "book"],
  },
];
const MANIFEST: ExtensionManifest = {
  id: EXT_ID,
  version: "1.0.0",
  permissions: { network: ["readwise.io"], filesystem: { read: [], write: [] } },
  publisher: { id: "nimbus", key: KEY },
  updateChannel: "stable",
  credentials: { token: { env: "READWISE_TOKEN" } },
  sync: { contract: "1", intervalSeconds: 300, itemTypes: ["highlight", "book"] },
};

describe("extension.remove purge (plan decision 7)", () => {
  test("extension remove purges readwise:* items, scheduler row, health row and readwise.token when bound", async () => {
    const root = tempRoot();
    const db = freshDb();
    const idx = new LocalIndex(db);
    const vault = createMemoryVault();
    const installPath = join(root, "installed");
    mkdirSync(installPath, { recursive: true });
    insertExtensionRow(db, {
      id: EXT_ID,
      version: "1.0.0",
      install_path: installPath,
      manifest_hash: "h",
      entry_hash: "e",
      installed_at: 1,
      last_verified_at: 1,
      tree_digest: "d",
    });
    dbRun(db, "UPDATE extension SET source_root_fingerprint = ? WHERE id = ?", [
      OFFICIAL_FP,
      EXT_ID,
    ]);
    upsertRunGrant(db, {
      extension_id: EXT_ID,
      service_id: CODE_ID,
      version: "1.0.0",
      tree_digest: "d",
      permissions_json: JSON.stringify({ network: ["readwise.io"], read: [], write: [] }),
      model_access: 0,
      approved_at: 1,
      credentials_json: JSON.stringify({
        token: { env: "READWISE_TOKEN", vaultKey: "readwise.token" },
      }),
    });
    idx.ensureConnectorSchedulerRegistration("readwise", 60_000, 1);
    idx.upsert({ id: "1", service: "readwise", itemType: "highlight", name: "h" });
    idx.upsert({ id: "book/2", service: "readwise", itemType: "book", name: "b" });
    idx.upsert({ id: "s1", service: "slack", itemType: "message", name: "kept" });
    transitionHealth(db, "readwise", { type: "paused", reason: "x" });
    await vault.set("readwise.token", "secret");
    await vault.set("slack.bot_token", "other");

    await dispatchAutomationRpc({
      db,
      method: "extension.remove",
      params: { id: EXT_ID },
      extensionSync: {
        refresh: () => {},
        unregister: () => {},
        purgeBeforeRemove: (id) =>
          purgeExtensionIndexData(
            { db, vault, localIndex: idx, table: TABLE, readManifest: () => MANIFEST },
            id,
          ),
      },
    });

    expect(idx.search({ service: "readwise" })).toEqual([]);
    expect(idx.search({ service: "slack" })).toHaveLength(1);
    const count = (sql: string): number => (db.query(sql).get("readwise") as { c: number }).c;
    expect(count("SELECT COUNT(*) AS c FROM scheduler_state WHERE service_id = ?")).toBe(0);
    expect(count("SELECT COUNT(*) AS c FROM sync_state WHERE connector_id = ?")).toBe(0);
    expect(await vault.get("readwise.token")).toBeNull();
    expect(await vault.get("slack.bot_token")).toBe("other");
  });

  test("an unbound extension's purge stays in its own ext_ namespace and keys", async () => {
    const db = freshDb();
    const idx = new LocalIndex(db);
    const vault = createMemoryVault();
    insertExtensionRow(db, {
      id: EXT_ID,
      version: "1.0.0",
      install_path: join(tmpdir(), "nowhere"),
      manifest_hash: "h",
      entry_hash: "e",
      installed_at: 1,
      last_verified_at: 1,
    });
    idx.upsert({ id: "1", service: "readwise", itemType: "highlight", name: "bundled" });
    idx.upsert({ id: "9", service: CODE_ID, itemType: "highlight", name: "mine" });
    await vault.set("readwise.token", "bundled-token");
    await vault.set(`ext.${CODE_ID}.token`, "mine");
    // No grant (revoked earlier): the derived code-server id is purged all the same.
    const out = await purgeExtensionIndexData(
      { db, vault, localIndex: idx, table: TABLE, readManifest: () => MANIFEST },
      EXT_ID,
    );
    expect(out).toEqual({
      indexServiceId: CODE_ID,
      itemsDeleted: 1,
      vaultKeysRemoved: [`ext.${CODE_ID}.token`],
    });
    expect(idx.search({ service: "readwise" })).toHaveLength(1);
    expect(await vault.get("readwise.token")).toBe("bundled-token");
  });
});
