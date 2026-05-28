import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import * as tar from "tar";

import { insertExtensionRow, listExtensions } from "../../../src/automation/extension-store.ts";
import { createAutoUpdateRuntime } from "../../../src/extensions/auto-update-init.ts";
import {
  _resetAutoUpdateMutexForTests,
  dispatchAutoUpdateRpc,
} from "../../../src/extensions/auto-update-rpc.ts";
import { writePublisherKey } from "../../../src/extensions/publisher-keys.ts";
import {
  encodeBase64,
  generateEd25519Keypair,
  signManifest,
} from "../../../src/extensions/verify-signature.ts";
import { MockVault } from "../../../src/vault/mock.ts";
import { setupFreshExtensionDb } from "../../fixtures/extension.ts";

interface RegistryEntry {
  version: string;
  manifest: Record<string, unknown>;
  manifestHash: string;
  entryHash: string;
  tarballBytes: Uint8Array;
}

async function startRegistry(): Promise<{
  baseUrl: string;
  set(id: string, entry: RegistryEntry): void;
  stop(): void;
}> {
  const entries = new Map<string, RegistryEntry>();
  let server: Server | undefined;
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const u = new URL(req.url);
      let m = /^\/v1\/extensions\/([^/]+)\/latest$/.exec(u.pathname);
      if (m !== null) {
        const e = entries.get(decodeURIComponent(m[1] ?? ""));
        if (e === undefined) return new Response("not found", { status: 404 });
        return new Response(JSON.stringify({ version: e.version, channel: "stable" }), {
          status: 200,
        });
      }
      m = /^\/v1\/extensions\/([^/]+)\/manifest$/.exec(u.pathname);
      if (m !== null) {
        const e = entries.get(decodeURIComponent(m[1] ?? ""));
        if (e === undefined) return new Response("not found", { status: 404 });
        const base = `http://localhost:${String(server?.port ?? 0)}`;
        return new Response(
          JSON.stringify({
            manifest: e.manifest,
            manifestHash: e.manifestHash,
            entryHash: e.entryHash,
            tarballUrl: `${base}/v1/tarball/${encodeURIComponent(
              decodeURIComponent(m[1] ?? ""),
            )}.tar.gz`,
            tarballSizeBytes: e.tarballBytes.byteLength,
          }),
          { status: 200 },
        );
      }
      m = /^\/v1\/tarball\/(.+)\.tar\.gz$/.exec(u.pathname);
      if (m !== null) {
        const e = entries.get(decodeURIComponent(m[1] ?? ""));
        if (e === undefined) return new Response("not found", { status: 404 });
        return new Response(e.tarballBytes, {
          status: 200,
          headers: { "content-length": String(e.tarballBytes.byteLength) },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    baseUrl: `http://localhost:${String(server.port)}`,
    set(id, entry) {
      entries.set(id, entry);
    },
    stop() {
      server?.stop();
    },
  };
}

async function buildTarball(opts: {
  extensionId: string;
  version: string;
  publisherId: string;
  pubkey: Uint8Array;
  privkey: Uint8Array;
}): Promise<{
  manifest: Record<string, unknown>;
  manifestHash: string;
  entryHash: string;
  tarballBytes: Uint8Array;
}> {
  const baseManifest = {
    id: opts.extensionId,
    version: opts.version,
    permissions: { network: [], filesystem: { read: [], write: [] } },
    publisher: { id: opts.publisherId, key: encodeBase64(opts.pubkey) },
  };
  const signature = await signManifest(baseManifest, opts.privkey);
  const manifest = { ...baseManifest, signature };
  const manifestText = JSON.stringify(manifest);
  const entryText = `export default { version: "${opts.version}" };`;

  const stage = mkdtempSync(join(tmpdir(), "nimbus-au-e2e-stage-"));
  try {
    writeFileSync(join(stage, "nimbus.extension.json"), manifestText, "utf8");
    mkdirSync(join(stage, "dist"), { recursive: true });
    writeFileSync(join(stage, "dist", "index.js"), entryText, "utf8");
    const tarPath = join(stage, "out.tar.gz");
    await tar.c({ cwd: stage, file: tarPath, gzip: true }, ["nimbus.extension.json", "dist"]);
    const tarballBytes = new Uint8Array(readFileSync(tarPath));
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    return {
      manifest,
      manifestHash: createHash("sha256").update(Buffer.from(manifestText, "utf8")).digest("hex"),
      entryHash: createHash("sha256").update(Buffer.from(tarballBytes)).digest("hex"),
      tarballBytes,
    };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

let registry: Awaited<ReturnType<typeof startRegistry>>;
let tmpRoot: string;

beforeEach(async () => {
  registry = await startRegistry();
  tmpRoot = mkdtempSync(join(tmpdir(), "nimbus-au-e2e-"));
  _resetAutoUpdateMutexForTests();
}, 30_000);

afterEach(() => {
  registry.stop();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("E2E: nimbus extension update / downgrade (CLI ↔ IPC contract)", () => {
  test("checkForUpdates {force} → update apply → disk swap; audit/output clean of secrets", async () => {
    const { db, extensionsDir } = setupFreshExtensionDb();
    try {
      const { privkey, pubkey } = generateEd25519Keypair();
      const vault = new MockVault();
      await writePublisherKey(vault, "pub-1", pubkey);

      const extensionId = "ext-pub-1";
      const extRoot = join(extensionsDir, extensionId);

      const v1 = {
        id: extensionId,
        version: "1.0.0",
        publisher: { id: "pub-1", key: encodeBase64(pubkey) },
      };
      const v1Sig = await signManifest(v1, privkey);
      const v1ManifestText = JSON.stringify({ ...v1, signature: v1Sig });
      const v1EntryText = `export default { version: "1.0.0" };`;
      mkdirSync(join(extRoot, "active", "dist"), { recursive: true });
      writeFileSync(join(extRoot, "active", "nimbus.extension.json"), v1ManifestText, "utf8");
      writeFileSync(join(extRoot, "active", "dist", "index.js"), v1EntryText, "utf8");

      const { createHash } = require("node:crypto") as typeof import("node:crypto");
      insertExtensionRow(db, {
        id: extensionId,
        version: "1.0.0",
        install_path: join(extRoot, "active"),
        manifest_hash: createHash("sha256")
          .update(Buffer.from(v1ManifestText, "utf8"))
          .digest("hex"),
        entry_hash: createHash("sha256").update(Buffer.from(v1EntryText, "utf8")).digest("hex"),
        enabled: 1,
        installed_at: Date.now(),
        last_verified_at: Date.now(),
      });

      const built = await buildTarball({
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
      const autoUpdateDeps = { ...runtime.deps, gate: async () => "proceed" as const };

      const list = (await dispatchAutoUpdateRpc(
        "extension.checkForUpdates",
        { force: true },
        autoUpdateDeps,
      )) as Array<{ id: string; fromVersion: string; toVersion: string }>;
      expect(list).toHaveLength(1);
      expect(list[0]?.id).toBe(extensionId);
      expect(list[0]?.toVersion).toBe("1.1.0");

      const apply = (await dispatchAutoUpdateRpc(
        "extension.update",
        { id: extensionId, toVersion: "1.1.0" },
        autoUpdateDeps,
      )) as { applied: boolean; jobId?: string };
      expect(apply.applied).toBe(true);
      expect(typeof apply.jobId).toBe("string");

      const activeManifest = JSON.parse(
        readFileSync(join(extRoot, "active", "nimbus.extension.json"), "utf8"),
      ) as { version: string };
      expect(activeManifest.version).toBe("1.1.0");
      expect(existsSync(join(extRoot, "_prev", "1.0.0"))).toBe(true);

      const row = listExtensions(db).find((r) => r.id === extensionId);
      expect(row?.version).toBe("1.1.0");

      const auditRows = db.query(`SELECT action_json FROM audit_log`).all() as Array<{
        action_json: string;
      }>;
      const auditDump = auditRows.map((r) => r.action_json).join("\n");
      expect(auditDump).not.toMatch(/sk_/);
      expect(auditDump).not.toMatch(/password/i);
      expect(auditDump).not.toMatch(/secret_value/i);

      const types = auditRows
        .map((r) => JSON.parse(r.action_json) as { id?: string })
        .filter((p) => p.id === extensionId).length;
      expect(types).toBeGreaterThan(0);
      const actionTypes = db.query(`SELECT action_type FROM audit_log`).all() as Array<{
        action_type: string;
      }>;
      const seen = new Set(actionTypes.map((r) => r.action_type));
      expect(seen.has("extension.autoUpdate.detected")).toBe(true);
      expect(seen.has("extension.autoUpdate.applied")).toBe(true);
    } finally {
      db.close();
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

      mkdirSync(join(extRoot, "active", "dist"), { recursive: true });
      writeFileSync(
        join(extRoot, "active", "nimbus.extension.json"),
        JSON.stringify({ id: extensionId, version: "1.1.0" }),
      );
      writeFileSync(
        join(extRoot, "active", "dist", "index.js"),
        `export default { version: "1.1.0" };`,
      );
      mkdirSync(join(extRoot, "_prev", "1.0.0", "dist"), { recursive: true });
      writeFileSync(
        join(extRoot, "_prev", "1.0.0", "nimbus.extension.json"),
        JSON.stringify({ id: extensionId, version: "1.0.0" }),
      );
      writeFileSync(
        join(extRoot, "_prev", "1.0.0", "dist", "index.js"),
        `export default { version: "1.0.0" };`,
      );

      const { createHash } = require("node:crypto") as typeof import("node:crypto");
      insertExtensionRow(db, {
        id: extensionId,
        version: "1.1.0",
        install_path: join(extRoot, "active"),
        manifest_hash: createHash("sha256")
          .update(readFileSync(join(extRoot, "active", "nimbus.extension.json")))
          .digest("hex"),
        entry_hash: createHash("sha256")
          .update(readFileSync(join(extRoot, "active", "dist", "index.js")))
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
        manifestHash: "d".repeat(64),
        signatureB64: "AA==",
        entryHash: "e".repeat(64),
        tarballUrl: "https://r/x",
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
        readFileSync(join(extRoot, "active", "nimbus.extension.json"), "utf8"),
      ) as { version: string };
      expect(activeManifest.version).toBe("1.0.0");
      expect(existsSync(join(extRoot, "_prev", "1.1.0"))).toBe(true);
    } finally {
      db.close();
      rmSync(extensionsDir, { recursive: true, force: true });
    }
  });

  test("publisher_key_missing path → {applied:false, reason, hint}", async () => {
    const { db, extensionsDir } = setupFreshExtensionDb();
    try {
      const vault = new MockVault();

      const extensionId = "ext-orphan";
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
        publisherStatus: "unverified",
        manifestHash: "d".repeat(64),
        signatureB64: "AA==",
        entryHash: "e".repeat(64),
        tarballUrl: "https://r/x",
        permissionDiff: {
          network: { added: [], removed: [] },
          filesystem: { read: { added: [], removed: [] }, write: { added: [], removed: [] } },
        },
        verificationStatus: "needs_sync",
        detectedAt: 1,
      });
      const autoUpdateDeps = { ...runtime.deps, gate: async () => "proceed" as const };

      const apply = (await dispatchAutoUpdateRpc(
        "extension.update",
        { id: extensionId, toVersion: "1.1.0" },
        autoUpdateDeps,
      )) as { applied: boolean; reason?: string; hint?: string };
      expect(apply.applied).toBe(false);
      expect(apply.reason).toBe("publisher_key_missing");
      expect(apply.hint).toMatch(/nimbus extension sync/);
    } finally {
      db.close();
      rmSync(extensionsDir, { recursive: true, force: true });
    }
  });
});
