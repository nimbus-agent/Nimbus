import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { insertExtensionRow, listExtensions } from "../../../src/automation/extension-store.ts";
import { createAutoUpdateRuntime } from "../../../src/extensions/auto-update-init.ts";
import {
  _resetAutoUpdateMutexForTests,
  dispatchAutoUpdateRpc,
} from "../../../src/extensions/auto-update-rpc.ts";
import { publisherKeyFingerprint } from "../../../src/extensions/install-from-local.ts";
import { writePublisherKey } from "../../../src/extensions/publisher-keys.ts";
import { buildTestRegistry } from "../../../src/extensions/registry/__fixtures__/build-test-registry.ts";
import { installFromRegistry } from "../../../src/extensions/registry/install-from-registry.ts";
import type { RegistryFetchDeps } from "../../../src/extensions/registry/registry-fetch.ts";
import { insertRegistry } from "../../../src/extensions/registry/registry-store.ts";
import { generateEd25519Keypair } from "../../../src/extensions/verify-signature.ts";
import {
  prevVersionDir,
  removeExtensionVersionStore,
} from "../../../src/extensions/version-store.ts";
import { MockVault } from "../../../src/vault/mock.ts";
import { setupFreshExtensionDb } from "../../fixtures/extension.ts";

/** A local-folder registry makes no network request at all; any remote fetch would fail. */
const NO_NETWORK: Omit<RegistryFetchDeps, "db"> = {
  fetchFn: () => Promise.reject(new Error("no network in this test")),
  enforceAirGap: () => false,
  now: () => Date.now(),
  production: false,
};

const ID = "ext-pub-1";
let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "nimbus-au-e2e-"));
  _resetAutoUpdateMutexForTests();
}, 30_000);

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** Installs `ID@1.0.0` from a local signed registry that also carries 1.1.0. */
async function installedFromRegistry(
  db: Parameters<typeof insertRegistry>[0],
  extensionsDir: string,
  vault: MockVault,
): Promise<void> {
  const regDir = join(tmpRoot, "registry");
  const reg = await buildTestRegistry(regDir, {
    id: ID,
    versions: [{ version: "1.0.0" }, { version: "1.1.0" }],
    publisherId: "pub-1",
  });
  insertRegistry(db, {
    name: "main",
    url: regDir,
    rootKey: reg.rootKey,
    rootFingerprint: publisherKeyFingerprint(reg.rootKey),
    lastSequence: 0,
    lastGeneratedAt: "2026-10-01T00:00:00Z",
    addedAt: 1,
  });
  await installFromRegistry(
    { db, extensionsDir, vault, fetch: NO_NETWORK, approve: async () => true },
    { id: ID, version: "1.0.0" },
  );
}

describe("E2E: nimbus extension update / downgrade (CLI ↔ IPC contract)", () => {
  test("checkForUpdates {force} → update apply → disk swap; audit/output clean of secrets", async () => {
    const { db, extensionsDir } = setupFreshExtensionDb();
    try {
      const vault = new MockVault();
      await installedFromRegistry(db, extensionsDir, vault);
      const extRoot = join(extensionsDir, ID);

      const runtime = createAutoUpdateRuntime({
        db,
        vault,
        extensionsDir,
        dataDir: tmpRoot,
        fetch: NO_NETWORK,
        intervalHours: 24,
      });
      const autoUpdateDeps = { ...runtime.deps, gate: async () => "proceed" as const };

      const list = (await dispatchAutoUpdateRpc(
        "extension.checkForUpdates",
        { force: true },
        autoUpdateDeps,
      )) as Array<{ id: string; toVersion: string; sourceRegistry: string }>;
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ id: ID, toVersion: "1.1.0", sourceRegistry: "main" });

      const apply = (await dispatchAutoUpdateRpc(
        "extension.update",
        { id: ID, toVersion: "1.1.0" },
        autoUpdateDeps,
      )) as { applied: boolean; jobId?: string };
      expect(apply.applied).toBe(true);
      expect(typeof apply.jobId).toBe("string");

      const activeManifest = JSON.parse(
        readFileSync(join(extRoot, "nimbus.extension.json"), "utf8"),
      ) as { version: string };
      expect(activeManifest.version).toBe("1.1.0");
      expect(existsSync(prevVersionDir(extensionsDir, ID, "1.0.0"))).toBe(true);

      const row = listExtensions(db).find((r) => r.id === ID);
      expect(row?.version).toBe("1.1.0");

      const auditRows = db.query(`SELECT action_json FROM audit_log`).all() as Array<{
        action_json: string;
      }>;
      const auditDump = auditRows.map((r) => r.action_json).join("\n");
      expect(auditDump).not.toMatch(/sk_/);
      expect(auditDump).not.toMatch(/password/i);
      expect(auditDump).not.toMatch(/secret_value/i);

      const actionTypes = db.query(`SELECT action_type FROM audit_log`).all() as Array<{
        action_type: string;
      }>;
      const seen = new Set(actionTypes.map((r) => r.action_type));
      expect(seen.has("extension.autoUpdate.detected")).toBe(true);
      expect(seen.has("extension.autoUpdate.applied")).toBe(true);
    } finally {
      db.close();
      removeExtensionVersionStore(extensionsDir, ID);
      rmSync(extensionsDir, { recursive: true, force: true });
    }
  });

  test("downgrade target → swap + _prev/<fromVersion>/", async () => {
    const { db, extensionsDir } = setupFreshExtensionDb();
    try {
      const { pubkey } = generateEd25519Keypair();
      const vault = new MockVault();
      await writePublisherKey(vault, "pub-1", pubkey);

      const extensionId = "ext-pub-1";
      const extRoot = join(extensionsDir, extensionId);

      mkdirSync(join(extRoot, "dist"), { recursive: true });
      writeFileSync(
        join(extRoot, "nimbus.extension.json"),
        JSON.stringify({ id: extensionId, version: "1.1.0" }),
      );
      writeFileSync(join(extRoot, "dist", "index.js"), `export default { version: "1.1.0" };`);
      mkdirSync(join(prevVersionDir(extensionsDir, extensionId, "1.0.0"), "dist"), {
        recursive: true,
      });
      writeFileSync(
        join(prevVersionDir(extensionsDir, extensionId, "1.0.0"), "nimbus.extension.json"),
        JSON.stringify({ id: extensionId, version: "1.0.0" }),
      );
      writeFileSync(
        join(prevVersionDir(extensionsDir, extensionId, "1.0.0"), "dist", "index.js"),
        `export default { version: "1.0.0" };`,
      );

      insertExtensionRow(db, {
        id: extensionId,
        version: "1.1.0",
        install_path: extRoot,
        manifest_hash: createHash("sha256")
          .update(readFileSync(join(extRoot, "nimbus.extension.json")))
          .digest("hex"),
        entry_hash: createHash("sha256")
          .update(readFileSync(join(extRoot, "dist", "index.js")))
          .digest("hex"),
        enabled: 1,
        installed_at: Date.now(),
        last_verified_at: Date.now(),
      });

      const runtime = createAutoUpdateRuntime({
        db,
        vault,
        extensionsDir,
        dataDir: tmpRoot,
        fetch: NO_NETWORK,
        intervalHours: 24,
      });
      runtime.deps.cache.upsert({
        id: extensionId,
        displayName: extensionId,
        fromVersion: "1.1.0",
        toVersion: "1.0.0",
        channel: "stable",
        changelog: "",
        publisherStatus: "verified",
        // The downgrade now measures `_prev/1.0.0` against these claims before swapping.
        manifestHash: createHash("sha256")
          .update(
            readFileSync(
              join(prevVersionDir(extensionsDir, extensionId, "1.0.0"), "nimbus.extension.json"),
            ),
          )
          .digest("hex"),
        signatureB64: "AA==",
        entryHash: createHash("sha256")
          .update(
            readFileSync(
              join(prevVersionDir(extensionsDir, extensionId, "1.0.0"), "dist", "index.js"),
            ),
          )
          .digest("hex"),
        packageSha256: "f".repeat(64),
        packageSizeBytes: 100,
        sourceRegistry: "main",
        rootFingerprint: "c".repeat(32),
        packagePath: "extensions/ext-pub-1/1.0.0/package.tgz",
        permissionDiff: {
          network: { added: [], removed: [] },
          filesystem: { read: { added: [], removed: [] }, write: { added: [], removed: [] } },
        },
        verificationStatus: "verified",
        detectedAt: 1,
      });
      const autoUpdateDeps = { ...runtime.deps, gate: async () => "proceed" as const };

      const apply = (await dispatchAutoUpdateRpc(
        "extension.update",
        { id: extensionId, toVersion: "1.0.0" },
        autoUpdateDeps,
      )) as { applied: boolean };
      expect(apply.applied).toBe(true);

      const activeManifest = JSON.parse(
        readFileSync(join(extRoot, "nimbus.extension.json"), "utf8"),
      ) as { version: string };
      expect(activeManifest.version).toBe("1.0.0");
      expect(existsSync(prevVersionDir(extensionsDir, extensionId, "1.1.0"))).toBe(true);
    } finally {
      db.close();
      removeExtensionVersionStore(extensionsDir, "ext-pub-1");
      rmSync(extensionsDir, { recursive: true, force: true });
    }
  });

  test("publisher_key_conflict path → {applied:false, reason, hint}, nothing swapped", async () => {
    const { db, extensionsDir } = setupFreshExtensionDb();
    try {
      const vault = new MockVault();
      await installedFromRegistry(db, extensionsDir, vault);
      // The Vault now trusts a DIFFERENT key for "pub-1" than the one the signed index names.
      await writePublisherKey(vault, "pub-1", generateEd25519Keypair().pubkey);

      const runtime = createAutoUpdateRuntime({
        db,
        vault,
        extensionsDir,
        dataDir: tmpRoot,
        fetch: NO_NETWORK,
        intervalHours: 24,
      });
      let asked = false;
      const autoUpdateDeps = {
        ...runtime.deps,
        gate: async () => {
          asked = true;
          return "proceed" as const;
        },
      };
      const list = (await dispatchAutoUpdateRpc(
        "extension.checkForUpdates",
        { force: true },
        autoUpdateDeps,
      )) as Array<{ verificationStatus: string }>;
      expect(list.map((u) => u.verificationStatus)).toEqual(["publisher_key_conflict"]);

      const apply = (await dispatchAutoUpdateRpc(
        "extension.update",
        { id: ID, toVersion: "1.1.0" },
        autoUpdateDeps,
      )) as { applied: boolean; reason?: string; hint?: string };
      expect(apply.applied).toBe(false);
      expect(apply.reason).toBe("publisher_key_conflict");
      expect(apply.hint).toContain("registry main");
      // Refused before the owner is ever asked, and nothing on disk moved.
      expect(asked).toBe(false);
      expect(listExtensions(db).find((r) => r.id === ID)?.version).toBe("1.0.0");
    } finally {
      db.close();
      removeExtensionVersionStore(extensionsDir, ID);
      rmSync(extensionsDir, { recursive: true, force: true });
    }
  });
});
