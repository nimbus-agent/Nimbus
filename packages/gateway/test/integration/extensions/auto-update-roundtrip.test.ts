import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publisherKeyFingerprint } from "@nimbus-dev/registry-format";
import type { Server } from "bun";
import { listExtensions } from "../../../src/automation/extension-store.ts";
import { createAutoUpdateRuntime } from "../../../src/extensions/auto-update-init.ts";
import {
  _resetAutoUpdateMutexForTests,
  dispatchAutoUpdateRpc,
} from "../../../src/extensions/auto-update-rpc.ts";
import { writePublisherKey } from "../../../src/extensions/publisher-keys.ts";
import { buildTestRegistry } from "../../../src/extensions/registry/__fixtures__/build-test-registry.ts";
import { installFromRegistry } from "../../../src/extensions/registry/install-from-registry.ts";
import type { RegistryFetchDeps } from "../../../src/extensions/registry/registry-fetch.ts";
import { insertRegistry } from "../../../src/extensions/registry/registry-store.ts";
import { computeExtensionTreeDigest } from "../../../src/extensions/tree-digest.ts";
import { verifyOneExtensionStrict } from "../../../src/extensions/verify-extensions.ts";
import { generateEd25519Keypair } from "../../../src/extensions/verify-signature.ts";
import {
  prevVersionDir,
  prevVersionsDir,
  removeExtensionVersionStore,
} from "../../../src/extensions/version-store.ts";
import { MockVault } from "../../../src/vault/mock.ts";
import { setupFreshExtensionDb } from "../../fixtures/extension.ts";

/** Serves a registry FOLDER over real loopback HTTP, so every request is a ledgered remote one. */
function serveRegistryFolder(dir: string): { url: string; stop: () => void } {
  const server: Server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      const parts = new URL(req.url).pathname.split("/").filter(Boolean);
      if (parts[0] !== "reg") return new Response("not found", { status: 404 });
      const path = join(dir, ...parts.slice(1));
      return existsSync(path)
        ? new Response(readFileSync(path))
        : new Response("not found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${String(server.port)}/reg/`, stop: () => server.stop(true) };
}

/** Registry fetch deps for a test: the real global `fetch`, no air-gap, not production. */
const FETCH: Omit<RegistryFetchDeps, "db"> = {
  fetchFn: (url, init) => fetch(url, init),
  enforceAirGap: () => false,
  now: () => Date.now(),
  production: false,
  builtin: null,
};

/** Fields every cached update needs that these hand-built entries do not exercise. */
const SOURCE_FIELDS = {
  packageSha256: "f".repeat(64),
  packageSizeBytes: 100,
  sourceRegistry: "main",
  rootFingerprint: "c".repeat(32),
  packagePath: "extensions/ext-pub-1/1.1.0/package.tgz",
} as const;

let tmpRoot: string;
let stopServer: (() => void) | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "nimbus-au-roundtrip-"));
  _resetAutoUpdateMutexForTests();
});

afterEach(() => {
  stopServer?.();
  stopServer = undefined;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("Extension auto-update — integration roundtrip (T2 PR 3 Task 22)", () => {
  test("poll → cache → apply a real signed upgrade from the source registry, end to end", async () => {
    const { db, extensionsDir } = setupFreshExtensionDb();
    const extensionId = "ext-pub-1";
    try {
      const regDir = join(tmpRoot, "registry");
      const reg = await buildTestRegistry(regDir, {
        id: extensionId,
        versions: [{ version: "1.0.0" }, { version: "1.1.0" }],
        publisherId: "pub-1",
      });
      const served = serveRegistryFolder(regDir);
      stopServer = served.stop;
      insertRegistry(db, {
        name: "main",
        url: served.url,
        rootKey: reg.rootKey,
        rootFingerprint: publisherKeyFingerprint(reg.rootKey),
        lastSequence: 0,
        lastGeneratedAt: "2026-10-01T00:00:00Z",
        addedAt: 1,
        lastIndexSha256: null,
      });
      const vault = new MockVault();
      await installFromRegistry(
        { db, extensionsDir, vault, fetch: FETCH, approve: async () => true },
        { id: extensionId, version: "1.0.0" },
      );
      const rowsBefore = db.query("SELECT COUNT(*) AS n FROM egress_ledger").get() as { n: number };

      const runtime = createAutoUpdateRuntime({
        db,
        vault,
        extensionsDir,
        dataDir: tmpRoot,
        fetch: FETCH,
        intervalHours: 24,
      });

      await runtime.daemon.pollOnce();
      const cached = runtime.deps.cache.get(extensionId);
      expect(cached).toMatchObject({
        toVersion: "1.1.0",
        verificationStatus: "verified",
        sourceRegistry: "main",
        rootFingerprint: publisherKeyFingerprint(reg.rootKey),
      });

      let asked: Record<string, unknown> | undefined;
      const res = (await dispatchAutoUpdateRpc(
        "extension.update",
        { id: extensionId, toVersion: "1.1.0" },
        {
          ...runtime.deps,
          gate: async (action) => {
            asked = action.payload;
            return "proceed" as const;
          },
        },
      )) as { applied: boolean; reason?: string };
      expect(res.applied).toBe(true);
      expect(asked).toMatchObject({
        sourceRegistry: "main",
        rootFingerprint: publisherKeyFingerprint(reg.rootKey),
      });

      const extRoot = join(extensionsDir, extensionId);
      const newManifestText = readFileSync(join(extRoot, "nimbus.extension.json"), "utf8");
      expect(JSON.parse(newManifestText).version).toBe("1.1.0");
      const prevEntries = readdirSync(prevVersionsDir(extensionsDir, extensionId));
      expect(prevEntries).toEqual(["1.0.0"]);

      const row = listExtensions(db).find((r) => r.id === extensionId);
      expect(row?.version).toBe("1.1.0");
      expect(row?.tree_digest).toBe(computeExtensionTreeDigest(row?.install_path ?? ""));
      expect(row).toBeDefined();
      if (row !== undefined) expect(verifyOneExtensionStrict(row)).toBe(true);

      // Every request after the install is one ledgered `registry`-class row, named after the
      // registry: detection (index + manifest), then apply (index + manifest re-verify + package).
      const methods = (
        db.query("SELECT method, destination FROM egress_ledger ORDER BY id").all() as Array<{
          method: string;
          destination: string;
        }>
      ).slice(rowsBefore.n);
      expect(methods).toEqual([
        { method: "registry.index", destination: "main" },
        { method: "registry.manifest", destination: "main" },
        { method: "registry.index", destination: "main" },
        { method: "registry.manifest", destination: "main" },
        { method: "registry.package", destination: "main" },
      ]);
    } finally {
      db.close();
      removeExtensionVersionStore(extensionsDir, extensionId);
      rmSync(extensionsDir, { recursive: true, force: true });
    }
  });

  test("downgrade with auto-approving gate swaps active and _prev", async () => {
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

      const { insertExtensionRow } = await import("../../../src/automation/extension-store.ts");
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
        fetch: FETCH,
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
        ...SOURCE_FIELDS,
        permissionDiff: {
          network: { added: [], removed: [] },
          filesystem: { read: { added: [], removed: [] }, write: { added: [], removed: [] } },
        },
        verificationStatus: "verified",
        detectedAt: 1,
      });

      const res = (await dispatchAutoUpdateRpc(
        "extension.update",
        { id: extensionId, toVersion: "1.0.0" },
        { ...runtime.deps, gate: async () => "proceed" as const },
      )) as { applied: boolean; reason?: string };
      expect(res.applied).toBe(true);

      const activeManifest = JSON.parse(
        readFileSync(join(extRoot, "nimbus.extension.json"), "utf8"),
      ) as { version: string };
      expect(activeManifest.version).toBe("1.0.0");

      expect(existsSync(prevVersionDir(extensionsDir, extensionId, "1.1.0"))).toBe(true);

      const row = listExtensions(db).find((r) => r.id === extensionId);
      expect(row?.version).toBe("1.0.0");
      expect(row?.tree_digest).toBe(computeExtensionTreeDigest(row?.install_path ?? ""));
      expect(row).toBeDefined();
      if (row !== undefined) expect(verifyOneExtensionStrict(row)).toBe(true);
    } finally {
      db.close();
      removeExtensionVersionStore(extensionsDir, "ext-pub-1");
      rmSync(extensionsDir, { recursive: true, force: true });
    }
  });

  test("concurrent extension.update for same id returns update_in_flight", async () => {
    const { db, extensionsDir } = setupFreshExtensionDb();
    try {
      const { pubkey } = generateEd25519Keypair();
      const vault = new MockVault();
      await writePublisherKey(vault, "pub-1", pubkey);

      const extensionId = "ext-pub-1";
      const runtime = createAutoUpdateRuntime({
        db,
        vault,
        extensionsDir,
        dataDir: tmpRoot,
        fetch: FETCH,
        intervalHours: 24,
      });

      runtime.deps.cache.upsert({
        id: extensionId,
        displayName: extensionId,
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
        channel: "stable",
        changelog: "",
        publisherStatus: "verified",
        manifestHash: "d".repeat(64),
        signatureB64: "AA==",
        entryHash: "e".repeat(64),
        ...SOURCE_FIELDS,
        permissionDiff: {
          network: { added: [], removed: [] },
          filesystem: { read: { added: [], removed: [] }, write: { added: [], removed: [] } },
        },
        verificationStatus: "verified",
        detectedAt: 1,
      });

      let release: () => void = () => {};
      const slowDeps = {
        ...runtime.deps,
        gate: async () => "proceed" as const,
        getInstalledVersion: async () => "1.0.0",
        // The hand-built entry names no real registry; this test is about the mutex.
        isSourceCurrent: async () => true,
        performUpgrade: async (): Promise<void> => {
          await new Promise<void>((r) => {
            release = r;
          });
        },
      };
      const first = dispatchAutoUpdateRpc(
        "extension.update",
        { id: extensionId, toVersion: "1.1.0" },
        slowDeps,
      );
      await new Promise((r) => setTimeout(r, 0));
      const second = (await dispatchAutoUpdateRpc(
        "extension.update",
        { id: extensionId, toVersion: "1.1.0" },
        slowDeps,
      )) as { applied: boolean; reason?: string };
      expect(second).toEqual({ applied: false, reason: "update_in_flight" });
      release();
      await first;
    } finally {
      db.close();
      removeExtensionVersionStore(extensionsDir, "ext-pub-1");
      rmSync(extensionsDir, { recursive: true, force: true });
    }
  });

  test("verify-extensions crash recovery promotes prev/<v>/ when the install dir is missing", async () => {
    const { db, extensionsDir } = setupFreshExtensionDb();
    try {
      const { pubkey } = generateEd25519Keypair();
      const vault = new MockVault();
      await writePublisherKey(vault, "pub-1", pubkey);

      const extensionId = "ext-pub-1";
      const extRoot = join(extensionsDir, extensionId);
      mkdirSync(join(prevVersionDir(extensionsDir, extensionId, "1.0.0"), "dist"), {
        recursive: true,
      });
      const manifestText = JSON.stringify({ id: extensionId, version: "1.0.0" });
      writeFileSync(
        join(prevVersionDir(extensionsDir, extensionId, "1.0.0"), "nimbus.extension.json"),
        manifestText,
      );
      writeFileSync(
        join(prevVersionDir(extensionsDir, extensionId, "1.0.0"), "dist", "index.js"),
        "// prev",
      );

      const manifestBytes = Buffer.from(manifestText, "utf8");
      const entryBytes = Buffer.from("// prev", "utf8");
      const manifestHash = createHash("sha256").update(manifestBytes).digest("hex");
      const entryHash = createHash("sha256").update(entryBytes).digest("hex");

      const { insertExtensionRow } = await import("../../../src/automation/extension-store.ts");
      insertExtensionRow(db, {
        id: extensionId,
        version: "1.1.0",
        install_path: extRoot,
        manifest_hash: manifestHash,
        entry_hash: entryHash,
        enabled: 1,
        installed_at: Date.now(),
        last_verified_at: Date.now(),
      });

      const { verifyExtensionsBestEffort } = await import(
        "../../../src/extensions/verify-extensions.ts"
      );
      const pino = (await import("pino")).default;
      await verifyExtensionsBestEffort(
        db,
        pino({ level: "silent" }),
        undefined,
        undefined,
        undefined,
        extensionsDir,
      );

      expect(existsSync(extRoot)).toBe(true);
      const row = listExtensions(db).find((r) => r.id === extensionId);
      expect(row?.version).toBe("1.0.0");
      // Promoted but not blessed: no digest, disabled until the owner runs `extension rehash`.
      expect(row?.tree_digest).toBeNull();
      expect(row?.enabled).toBe(0);
      const auditRow = db
        .query(`SELECT action_type FROM audit_log WHERE action_type = ? ORDER BY id DESC LIMIT 1`)
        .get("extension.autoUpdate.crash_recovered") as { action_type: string } | undefined;
      expect(auditRow).toBeDefined();
    } finally {
      db.close();
      removeExtensionVersionStore(extensionsDir, "ext-pub-1");
      rmSync(extensionsDir, { recursive: true, force: true });
    }
  });
});
