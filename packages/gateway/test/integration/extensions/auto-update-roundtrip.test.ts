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
import type { Server } from "bun";
import * as tar from "tar";

import { listExtensions } from "../../../src/automation/extension-store.ts";
import { createAutoUpdateRuntime } from "../../../src/extensions/auto-update-init.ts";
import {
  _resetAutoUpdateMutexForTests,
  dispatchAutoUpdateRpc,
} from "../../../src/extensions/auto-update-rpc.ts";
import { writePublisherKey } from "../../../src/extensions/publisher-keys.ts";
import { computeExtensionTreeDigest } from "../../../src/extensions/tree-digest.ts";
import { verifyOneExtensionStrict } from "../../../src/extensions/verify-extensions.ts";
import {
  encodeBase64,
  generateEd25519Keypair,
  signManifest,
} from "../../../src/extensions/verify-signature.ts";
import {
  prevVersionDir,
  prevVersionsDir,
  removeExtensionVersionStore,
} from "../../../src/extensions/version-store.ts";
import { MockVault } from "../../../src/vault/mock.ts";
import { setupFreshExtensionDb } from "../../fixtures/extension.ts";

interface RegistryEntry {
  version: string;
  manifest: Record<string, unknown>;
  manifestHash: string;
  entryHash: string;
  tarballBytes: Uint8Array;
}

interface FakeRegistry {
  baseUrl: string;
  set(extensionId: string, entry: RegistryEntry): void;
  stop(): void;
}

async function startFakeRegistry(): Promise<FakeRegistry> {
  const entries = new Map<string, RegistryEntry>();
  let server: Server | undefined;
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const u = new URL(req.url);
      let m = /^\/v1\/extensions\/([^/]+)\/latest$/.exec(u.pathname);
      if (m !== null) {
        const entry = entries.get(decodeURIComponent(m[1] ?? ""));
        if (entry === undefined) return new Response("not found", { status: 404 });
        return new Response(JSON.stringify({ version: entry.version, channel: "stable" }), {
          status: 200,
        });
      }
      m = /^\/v1\/extensions\/([^/]+)\/manifest$/.exec(u.pathname);
      if (m !== null) {
        const entry = entries.get(decodeURIComponent(m[1] ?? ""));
        if (entry === undefined) return new Response("not found", { status: 404 });
        const baseUrlForTarball = `http://localhost:${String(server?.port ?? 0)}`;
        return new Response(
          JSON.stringify({
            manifest: entry.manifest,
            manifestHash: entry.manifestHash,
            entryHash: entry.entryHash,
            tarballSha256: createHash("sha256").update(entry.tarballBytes).digest("hex"),
            tarballUrl: `${baseUrlForTarball}/v1/tarball/${encodeURIComponent(
              decodeURIComponent(m[1] ?? ""),
            )}.tar.gz`,
            tarballSizeBytes: entry.tarballBytes.byteLength,
          }),
          { status: 200 },
        );
      }
      m = /^\/v1\/tarball\/(.+)\.tar\.gz$/.exec(u.pathname);
      if (m !== null) {
        const entry = entries.get(decodeURIComponent(m[1] ?? ""));
        if (entry === undefined) return new Response("not found", { status: 404 });
        return new Response(entry.tarballBytes, {
          status: 200,
          headers: { "content-length": String(entry.tarballBytes.byteLength) },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    baseUrl: `http://localhost:${String(server.port)}`,
    set(extensionId, entry) {
      entries.set(extensionId, entry);
    },
    stop() {
      server?.stop();
    },
  };
}

interface BuiltNewVersion {
  manifest: Record<string, unknown>;
  manifestHash: string;
  entryHash: string;
  tarballBytes: Uint8Array;
}

async function buildSignedTarball(opts: {
  extensionId: string;
  version: string;
  publisherId: string;
  pubkey: Uint8Array;
  privkey: Uint8Array;
  permissions?: { network: string[]; filesystem: { read: string[]; write: string[] } };
  entrySource?: string;
}): Promise<BuiltNewVersion> {
  const permissions = opts.permissions ?? {
    network: [],
    filesystem: { read: [], write: [] },
  };
  const baseManifest = {
    id: opts.extensionId,
    version: opts.version,
    permissions,
    publisher: { id: opts.publisherId, key: encodeBase64(opts.pubkey) },
  };
  const signature = await signManifest(baseManifest, opts.privkey);
  const manifest = { ...baseManifest, signature };

  const stageRoot = mkdtempSync(join(tmpdir(), "nimbus-au-stage-"));
  try {
    const manifestText = JSON.stringify(manifest);
    writeFileSync(join(stageRoot, "nimbus.extension.json"), manifestText, "utf8");
    mkdirSync(join(stageRoot, "dist"), { recursive: true });
    const entryText = opts.entrySource ?? `export default { version: "${opts.version}" };`;
    writeFileSync(join(stageRoot, "dist", "index.js"), entryText, "utf8");

    const manifestBytes = Buffer.from(manifestText, "utf8");
    const sha256Hex = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

    const tarPath = join(stageRoot, "out.tar.gz");
    await tar.c({ cwd: stageRoot, file: tarPath, gzip: true }, ["nimbus.extension.json", "dist"]);
    const tarballBytes = new Uint8Array(readFileSync(tarPath));

    return {
      manifest,
      manifestHash: sha256Hex(manifestBytes),
      // The ENTRY FILE's hash, as a real registry must publish it — not the tarball's.
      entryHash: sha256Hex(Buffer.from(entryText, "utf8")),
      tarballBytes,
    };
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}

let registry: FakeRegistry;
let tmpRoot: string;

beforeEach(async () => {
  registry = await startFakeRegistry();
  tmpRoot = mkdtempSync(join(tmpdir(), "nimbus-au-roundtrip-"));
  _resetAutoUpdateMutexForTests();
});

afterEach(() => {
  registry.stop();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("Extension auto-update — integration roundtrip (T2 PR 3 Task 22)", () => {
  test("poll → cache → apply forward upgrade end-to-end", async () => {
    const { db, extensionsDir } = setupFreshExtensionDb();
    try {
      const { privkey, pubkey } = generateEd25519Keypair();
      const vault = new MockVault();
      await writePublisherKey(vault, "pub-1", pubkey);

      const extensionId = "ext-pub-1";
      const extRoot = join(extensionsDir, extensionId);

      const v1Manifest = {
        id: extensionId,
        version: "1.0.0",
        publisher: { id: "pub-1", key: encodeBase64(pubkey) },
      };
      const v1Sig = await signManifest(v1Manifest, privkey);
      const v1Signed = { ...v1Manifest, signature: v1Sig };
      mkdirSync(join(extRoot, "dist"), { recursive: true });
      const v1ManifestText = JSON.stringify(v1Signed);
      writeFileSync(join(extRoot, "nimbus.extension.json"), v1ManifestText, "utf8");
      const v1EntryText = `export default { version: "1.0.0" };`;
      writeFileSync(join(extRoot, "dist", "index.js"), v1EntryText, "utf8");

      const { insertExtensionRow } = await import("../../../src/automation/extension-store.ts");
      insertExtensionRow(db, {
        id: extensionId,
        version: "1.0.0",
        install_path: extRoot,
        manifest_hash: createHash("sha256")
          .update(Buffer.from(v1ManifestText, "utf8"))
          .digest("hex"),
        entry_hash: createHash("sha256").update(Buffer.from(v1EntryText, "utf8")).digest("hex"),
        enabled: 1,
        installed_at: Date.now(),
        last_verified_at: Date.now(),
      });

      const built = await buildSignedTarball({
        extensionId,
        version: "1.1.0",
        publisherId: "pub-1",
        pubkey,
        privkey,
      });
      registry.set(extensionId, {
        version: "1.1.0",
        manifest: built.manifest,
        manifestHash: built.manifestHash,
        entryHash: built.entryHash,
        tarballBytes: built.tarballBytes,
      });

      const runtime = createAutoUpdateRuntime({
        db,
        vault,
        extensionsDir,
        dataDir: tmpRoot,
        registryBaseUrl: registry.baseUrl,
        intervalHours: 24,
        enforceAirGap: false,
      });

      await runtime.daemon.pollOnce();
      const cached = runtime.deps.cache.get(extensionId);
      expect(cached).toBeDefined();
      expect(cached?.toVersion).toBe("1.1.0");
      expect(cached?.verificationStatus).toBe("verified");

      const res = (await dispatchAutoUpdateRpc(
        "extension.update",
        { id: extensionId, toVersion: "1.1.0" },
        { ...runtime.deps, gate: async () => "proceed" as const },
      )) as { applied: boolean; reason?: string };
      expect(res.applied).toBe(true);

      const newManifestText = readFileSync(join(extRoot, "nimbus.extension.json"), "utf8");
      expect(JSON.parse(newManifestText).version).toBe("1.1.0");

      const prevEntries = readdirSync(prevVersionsDir(extensionsDir, extensionId));
      expect(prevEntries).toEqual(["1.0.0"]);

      const row = listExtensions(db).find((r) => r.id === extensionId);
      expect(row?.version).toBe("1.1.0");
      // The swap replaced the bytes, so the digest is the NEW tree's, recomputed — not the
      // install-time one, and not cleared.
      expect(row?.tree_digest).toBe(computeExtensionTreeDigest(row?.install_path ?? ""));
      // The row's hashes must survive the next startup verification. Before the registry's
      // `entryHash` was read as the entry file's hash everywhere, auto-update stored the
      // TARBALL's hash here and this returned false.
      expect(row).toBeDefined();
      if (row !== undefined) expect(verifyOneExtensionStrict(row)).toBe(true);
    } finally {
      db.close();
      removeExtensionVersionStore(extensionsDir, "ext-pub-1");
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
        registryBaseUrl: registry.baseUrl,
        intervalHours: 24,
        enforceAirGap: false,
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
        tarballSha256: "f".repeat(64),
        tarballUrl: "https://r/x",
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
        registryBaseUrl: registry.baseUrl,
        intervalHours: 24,
        enforceAirGap: false,
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
        tarballSha256: "f".repeat(64),
        tarballUrl: "https://r/x",
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
