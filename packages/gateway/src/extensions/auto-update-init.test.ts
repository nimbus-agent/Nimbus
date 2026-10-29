import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publisherKeyFingerprint, signTrustStatement } from "@nimbus-dev/registry-format";
import nacl from "tweetnacl";
import { rmDirWithRetry } from "../../test/helpers/rm-dir-with-retry.ts";
import {
  getExtensionKind,
  insertExtensionRow,
  listExtensions,
  setInstalledAsDependency,
} from "../automation/extension-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { MockVault } from "../vault/mock.ts";
import { createAutoUpdateRuntime, withUpdateAppliedHook } from "./auto-update-init.ts";
import { _resetAutoUpdateMutexForTests, dispatchAutoUpdateRpc } from "./auto-update-rpc.ts";
import type { AvailableUpdate } from "./auto-update-types.ts";
import { forwardDeps, recordInstall } from "./dependency-store.ts";
import { computeExtensionPackageHashes } from "./package-hashes.ts";
import { evictPublisherKey, writePublisherKey } from "./publisher-keys.ts";
import {
  buildTestRegistry,
  PUBLISHER_SEED,
  resignIndex,
  type TestVersion,
} from "./registry/__fixtures__/build-test-registry.ts";
import { installFromRegistry } from "./registry/install-from-registry.ts";
import type { RegistryFetchDeps } from "./registry/registry-fetch.ts";
import { deleteRegistry, insertRegistry } from "./registry/registry-store.ts";
import { getRunGrant, upsertRunGrant } from "./run-grant-store.ts";
import { recordTrustStatements } from "./trust/trust-store.ts";
import { encodeBase64, generateEd25519Keypair, signManifest } from "./verify-signature.ts";
import { prevVersionDir } from "./version-store.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  return db;
}

/** Registry fetch deps with no network at all: a remote registry request fails loudly. */
const NO_NETWORK: Omit<RegistryFetchDeps, "db"> = {
  fetchFn: () => Promise.reject(new Error("no network in this test")),
  enforceAirGap: () => false,
  now: () => Date.now(),
  production: false,
  // Neutral test default: never reach the real official registry host.
  builtin: null,
};

function baseOpts(db: Database, extensionsDir: string, dataDir: string) {
  return {
    db,
    vault: new MockVault(),
    extensionsDir,
    dataDir,
    fetch: NO_NETWORK,
    intervalHours: 24,
  };
}

/** Write a minimal valid manifest JSON to `dir/nimbus.extension.json` and insert a DB row. */
async function stageExtension(opts: {
  db: Database;
  dir: string;
  id: string;
  version?: string;
  publisherId?: string;
  pubkey?: Uint8Array;
  privkey?: Uint8Array;
  name?: string;
  enabled?: number;
  /** If set, write this raw string instead of valid JSON */
  rawManifestOverride?: string;
}): Promise<void> {
  const version = opts.version ?? "1.0.0";
  const enabled = opts.enabled ?? 1;

  let manifestContent: string;

  if (opts.rawManifestOverride !== undefined) {
    manifestContent = opts.rawManifestOverride;
  } else {
    const base: Record<string, unknown> = {
      id: opts.id,
      version,
    };
    if (opts.name !== undefined) {
      base["name"] = opts.name;
    }
    if (opts.publisherId !== undefined && opts.pubkey !== undefined) {
      base["publisher"] = { id: opts.publisherId, key: encodeBase64(opts.pubkey) };
    }
    if (opts.privkey !== undefined && opts.publisherId !== undefined && opts.pubkey !== undefined) {
      const withoutSig = {
        id: opts.id,
        version,
        permissions: {},
        publisher: { id: opts.publisherId, key: encodeBase64(opts.pubkey) },
      };
      const sig = await signManifest(withoutSig, opts.privkey);
      base["signature"] = sig;
      base["permissions"] = {};
    }

    manifestContent = JSON.stringify(base);
  }

  mkdirSync(opts.dir, { recursive: true });
  writeFileSync(join(opts.dir, "nimbus.extension.json"), manifestContent, "utf8");

  insertExtensionRow(opts.db, {
    id: opts.id,
    version,
    install_path: opts.dir,
    manifest_hash: "a".repeat(64),
    entry_hash: "b".repeat(64),
    enabled,
    installed_at: Date.now(),
    last_verified_at: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Describe: listInstalledRows branches (driven via deps.forcePoll / pollOnce)
// ---------------------------------------------------------------------------

describe("auto-update-init: listInstalledRows branches", () => {
  let tmpRoot: string;
  afterEach(() => {
    try {
      if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it("line 56: skips extension rows whose install_path has no manifest file", async () => {
    // Arrange: extension row pointing to a directory with NO manifest.
    tmpRoot = mkdtempSync(join(tmpdir(), "nimbus-au-init-nomf-"));
    const db = freshDb();
    const extDir = join(tmpRoot, "no-manifest-ext");
    mkdirSync(extDir, { recursive: true }); // dir exists but no nimbus.extension.json

    insertExtensionRow(db, {
      id: "no.manifest.ext",
      version: "1.0.0",
      install_path: extDir,
      manifest_hash: "a".repeat(64),
      entry_hash: "b".repeat(64),
      enabled: 1,
      installed_at: Date.now(),
      last_verified_at: Date.now(),
    });

    const { deps } = createAutoUpdateRuntime(
      baseOpts(db, join(tmpRoot, "extensions"), join(tmpRoot, "data")),
    );

    // forcePoll calls pollOnce → listInstalledRows → mp === undefined → continue.
    await deps.forcePoll(); // should not throw

    // The row has no publisher anyway so cache stays empty — what matters is no crash.
    expect(deps.cache.list()).toHaveLength(0);
  });

  it("lines 67/68: manifest WITHOUT name/publisher/signature → those fields absent in InstalledRow", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "nimbus-au-init-nofields-"));
    const db = freshDb();
    const extDir = join(tmpRoot, "bare-ext");
    // Write manifest with id+version only (no name, no publisher, no signature)
    await stageExtension({ db, dir: extDir, id: "bare.ext" });

    const { deps } = createAutoUpdateRuntime(
      baseOpts(db, join(tmpRoot, "extensions"), join(tmpRoot, "data")),
    );

    // pollOnce runs listInstalledRows; row has no publisher so daemon skips it,
    // but listInstalledRows still had to build the row with the conditional spreads.
    await deps.forcePoll();

    // The ext has no publisher so pollOnce skips it silently (no cache entry).
    expect(deps.cache.list()).toHaveLength(0);
  });

  it("a signed LOCAL-path install is never polled (no source registry), and no fetch is attempted", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "nimbus-au-init-allfields-"));
    const db = freshDb();
    const { pubkey, privkey } = generateEd25519Keypair();
    const extDir = join(tmpRoot, "signed-ext");
    await stageExtension({
      db,
      dir: extDir,
      id: "signed.ext",
      publisherId: "test-pub",
      pubkey,
      privkey,
      name: "My Extension",
    });

    const { deps } = createAutoUpdateRuntime(
      baseOpts(db, join(tmpRoot, "extensions"), join(tmpRoot, "data")),
    );

    // The row is signed but has no `source_registry`, so the daemon never hands it to `collect`;
    // NO_NETWORK would reject any request, and forcePoll resolves.
    await deps.forcePoll();
    expect(deps.cache.list()).toHaveLength(0);
  });

  it("lines 80-82: malformed manifest JSON → row silently skipped (no throw)", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "nimbus-au-init-malformed-"));
    const db = freshDb();
    const extDir = join(tmpRoot, "bad-json-ext");
    // Provide a raw, invalid JSON string to trigger the catch block.
    await stageExtension({
      db,
      dir: extDir,
      id: "bad.json.ext",
      rawManifestOverride: "{ this is not valid JSON !!!",
    });

    const { deps } = createAutoUpdateRuntime(
      baseOpts(db, join(tmpRoot, "extensions"), join(tmpRoot, "data")),
    );

    // Should NOT throw; the catch silently skips the malformed row.
    await deps.forcePoll();
    expect(deps.cache.list()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Describe: getInstalledVersion and hasPrevVersion (lines 201-210)
// ---------------------------------------------------------------------------

describe("auto-update-init: getInstalledVersion and hasPrevVersion", () => {
  let tmpRoot: string;
  afterEach(() => {
    try {
      if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it("getInstalledVersion returns null when no row exists for id (line 203: ?? null branch)", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "nimbus-au-init-getver-"));
    const db = freshDb();
    // No extension rows inserted.
    const { deps } = createAutoUpdateRuntime(
      baseOpts(db, join(tmpRoot, "extensions"), join(tmpRoot, "data")),
    );

    const result = await deps.getInstalledVersion("not.installed");
    expect(result).toBeNull();
  });

  it("getInstalledVersion returns version string when row exists (line 203: row?.version path)", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "nimbus-au-init-getver2-"));
    const db = freshDb();
    const extDir = join(tmpRoot, "ext-getver");
    await stageExtension({ db, dir: extDir, id: "ext.getver", version: "2.3.4" });

    const { deps } = createAutoUpdateRuntime(
      baseOpts(db, join(tmpRoot, "extensions"), join(tmpRoot, "data")),
    );

    const result = await deps.getInstalledVersion("ext.getver");
    expect(result).toBe("2.3.4");
  });

  it("hasPrevVersion returns false when no row exists for id (line 207: !row branch)", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "nimbus-au-init-prevver-"));
    const db = freshDb();
    const { deps } = createAutoUpdateRuntime(
      baseOpts(db, join(tmpRoot, "extensions"), join(tmpRoot, "data")),
    );

    const result = await deps.hasPrevVersion("not.installed", "1.0.0");
    expect(result).toBe(false);
  });

  it("hasPrevVersion returns false when row exists but prev/<version> dir does NOT exist", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "nimbus-au-init-prevno-"));
    const db = freshDb();
    const extDir = join(tmpRoot, "ext-prevno");
    await stageExtension({ db, dir: extDir, id: "ext.prevno", version: "1.0.0" });

    const { deps } = createAutoUpdateRuntime(
      baseOpts(db, join(tmpRoot, "extensions"), join(tmpRoot, "data")),
    );

    // prev/1.0.0 does NOT exist on disk.
    const result = await deps.hasPrevVersion("ext.prevno", "1.0.0");
    expect(result).toBe(false);
  });

  it("hasPrevVersion returns true when row exists AND prev/<version> dir exists (line 209: existsSync true)", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "nimbus-au-init-prevyes-"));
    const db = freshDb();
    const extDir = join(tmpRoot, "ext-prevyes");
    await stageExtension({ db, dir: extDir, id: "ext.prevyes", version: "1.0.0" });

    // Manually create the prev/<version> directory in the versions area.
    const prevDir = prevVersionDir(join(tmpRoot, "extensions"), "ext.prevyes", "1.0.0");
    mkdirSync(prevDir, { recursive: true });

    expect(existsSync(prevDir)).toBe(true);

    const { deps } = createAutoUpdateRuntime(
      baseOpts(db, join(tmpRoot, "extensions"), join(tmpRoot, "data")),
    );

    const result = await deps.hasPrevVersion("ext.prevyes", "1.0.0");
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Describe: fetchManifest mapping branches via fake HTTP server (lines 133,139,143,145,147)
// ---------------------------------------------------------------------------

describe("auto-update-init: hasRunGrant (extension runtime PR 3)", () => {
  let tmpRoot: string;
  afterEach(() => {
    try {
      if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it("answers from the run-grant store", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "nimbus-au-init-grant-"));
    const db = freshDb();
    await stageExtension({ db, dir: join(tmpRoot, "ext"), id: "com.example.g" });
    const { deps } = createAutoUpdateRuntime(
      baseOpts(db, join(tmpRoot, "extensions"), join(tmpRoot, "data")),
    );
    expect(await deps.hasRunGrant?.("com.example.g")).toBe(false);
    upsertRunGrant(db, {
      extension_id: "com.example.g",
      service_id: "ext_com_example_g",
      version: "1.0.0",
      tree_digest: "c".repeat(64),
      permissions_json: "{}",
      model_access: 0,
      approved_at: 1,
      credentials_json: "{}",
    });
    expect(await deps.hasRunGrant?.("com.example.g")).toBe(true);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Describe: detect and apply against a real (local-folder) signed registry
// ---------------------------------------------------------------------------

describe("auto-update-init: registry-sourced detect and apply", () => {
  const ID = "com.example.tool";
  let tmpRoot: string;
  let db: Database;
  afterEach(() => {
    db.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  /** Installs 1.0.0 from a local registry that also carries 1.2.0, and builds the runtime. */
  async function installedFromRegistry(
    versions: TestVersion[] = [{ version: "1.0.0" }, { version: "1.2.0" }],
  ) {
    tmpRoot = mkdtempSync(join(tmpdir(), "nimbus-au-init-reg-"));
    db = freshDb();
    const regDir = join(tmpRoot, "registry");
    const extensionsDir = join(tmpRoot, "extensions");
    const reg = await buildTestRegistry(regDir, { id: ID, versions });
    insertRegistry(db, {
      name: "main",
      url: regDir,
      rootKey: reg.rootKey,
      rootFingerprint: publisherKeyFingerprint(reg.rootKey),
      lastSequence: 0,
      lastGeneratedAt: "2026-10-01T00:00:00Z",
      addedAt: 1,
      lastIndexSha256: null,
    });
    const vault = new MockVault();
    await installFromRegistry(
      { db, extensionsDir, vault, fetch: NO_NETWORK, approve: async () => true },
      { id: ID, version: "1.0.0" },
    );
    const runtime = createAutoUpdateRuntime({
      ...baseOpts(db, extensionsDir, join(tmpRoot, "data")),
      vault,
    });
    return { runtime, regDir, extensionsDir, vault };
  }

  function installedVersion(): string {
    return (db.query("SELECT version FROM extension WHERE id = ?").get(ID) as { version: string })
      .version;
  }

  function kindOf(): string | undefined {
    return getExtensionKind(db, ID);
  }

  it("detects the newer version and applies a real signed upgrade end to end", async () => {
    const { runtime, extensionsDir } = await installedFromRegistry();
    const before = db.query("SELECT tree_digest FROM extension WHERE id = ?").get(ID) as {
      tree_digest: string;
    };
    await runtime.deps.forcePoll();
    const cached = runtime.deps.cache.get(ID);
    expect(cached).toMatchObject({
      fromVersion: "1.0.0",
      toVersion: "1.2.0",
      sourceRegistry: "main",
      verificationStatus: "verified",
    });
    if (cached === undefined) throw new Error("no update detected");
    upsertRunGrant(db, {
      extension_id: ID,
      service_id: "ext_update_code",
      version: "1.0.0",
      tree_digest: before.tree_digest,
      permissions_json: "{}",
      model_access: 0,
      approved_at: 1,
      credentials_json: "{}",
    });

    await runtime.deps.performUpgrade(cached);

    const row = db.query("SELECT version, tree_digest FROM extension WHERE id = ?").get(ID) as {
      version: string;
      tree_digest: string;
    };
    expect(row.version).toBe("1.2.0");
    // A code-to-code update leaves an existing grant in place (stale, not deleted).
    expect(getRunGrant(db, ID)?.version).toBe("1.0.0");
    // A new tree digest is what leaves any I43 run grant stale: the owner must re-approve.
    expect(row.tree_digest).not.toBe(before.tree_digest);
    expect(readFileSync(join(extensionsDir, ID, "dist", "index.js"), "utf8")).toContain("1.2.0");
    // The key the update verified with is recorded on the row and kept under its fingerprint.
    const fp = (
      db.query("SELECT publisher_key_fingerprint AS fp FROM extension WHERE id = ?").get(ID) as {
        fp: string | null;
      }
    ).fp;
    expect(fp).toBe(
      publisherKeyFingerprint(encodeBase64(nacl.sign.keyPair.fromSeed(PUBLISHER_SEED).publicKey)),
    );
  });

  it("apply refuses a package whose sha differs from the one the index signed", async () => {
    const { runtime, regDir, extensionsDir } = await installedFromRegistry();
    await runtime.deps.forcePoll();
    const cached = runtime.deps.cache.get(ID);
    if (cached === undefined) throw new Error("no update detected");
    // The registry now serves different package bytes under the same signed index.
    writeFileSync(join(regDir, "extensions", ID, "1.2.0", "package.tgz"), "tampered");

    await expect(runtime.deps.performUpgrade(cached)).rejects.toThrow(/sha256_mismatch/);
    expect(installedVersion()).toBe("1.0.0");
    expect(readFileSync(join(extensionsDir, ID, "dist", "index.js"), "utf8")).toContain("1.0.0");
  });

  it("a retry after a failed apply re-verifies the manifest instead of reusing the failed attempt's", async () => {
    const { runtime, regDir } = await installedFromRegistry();
    await runtime.deps.forcePoll();
    const cached = runtime.deps.cache.get(ID);
    if (cached === undefined) throw new Error("no update detected");
    // Attempt 1 re-verifies the manifest, then fails on the package bytes.
    writeFileSync(join(regDir, "extensions", ID, "1.2.0", "package.tgz"), "tampered");
    await expect(runtime.deps.performUpgrade(cached)).rejects.toThrow(/sha256_mismatch/);
    // The registry re-publishes with manifests that no longer verify: only a fresh re-verification
    // finds out (it refuses the version the cached update names).
    await buildTestRegistry(regDir, {
      id: ID,
      versions: [{ version: "1.0.0" }, { version: "1.2.0" }],
      badManifestSignature: true,
    });
    await expect(runtime.deps.performUpgrade(cached)).rejects.toThrow(/^signature_failed: /);
    expect(installedVersion()).toBe("1.0.0");
  });

  it("apply refuses when the re-fetched manifest signature fails, even for a cached 'verified' update", async () => {
    const { runtime, regDir } = await installedFromRegistry();
    // The registry re-publishes its versions with manifests that no longer verify.
    await buildTestRegistry(regDir, {
      id: ID,
      versions: [{ version: "1.0.0" }, { version: "1.2.0" }],
      badManifestSignature: true,
    });
    await runtime.deps.forcePoll();
    const cached = runtime.deps.cache.get(ID);
    expect(cached?.verificationStatus).toBe("signature_failed");
    if (cached === undefined) throw new Error("no update detected");
    // Apply does not trust the cache: a status forged to "verified" is re-checked and refused.
    await expect(
      runtime.deps.performUpgrade({ ...cached, verificationStatus: "verified" }),
    ).rejects.toThrow(/^signature_failed: .*ERR_REGISTRY_SIGNATURE_INVALID/);
    expect(installedVersion()).toBe("1.0.0");
  });

  it("applies an update whose re-fetched manifest is a starter pack, and the row's kind follows it", async () => {
    const { runtime, regDir } = await installedFromRegistry();
    await runtime.deps.forcePoll();
    const cached = runtime.deps.cache.get(ID);
    if (cached === undefined) throw new Error("no update detected");
    // The registry re-publishes 1.2.0 as a starter pack. The cached update is pointed at the new
    // signed artifacts, so only the manifest's kind can stop it at apply.
    await buildTestRegistry(regDir, {
      id: ID,
      versions: [{ version: "1.0.0" }, { version: "1.2.0", starterPack: true }],
      manifestExtra: { requires: { connectors: ["github"] } },
    });
    const index = JSON.parse(readFileSync(join(regDir, "index.json"), "utf8")) as {
      extensions: Record<
        string,
        {
          versions: Record<
            string,
            { manifestSha256: string; packageSha256: string; entryHash: string }
          >;
        }
      >;
    };
    const v = index.extensions[ID]?.versions["1.2.0"];
    if (v === undefined) throw new Error("no 1.2.0 in the re-published index");
    expect(kindOf()).toBe("extension");
    // The owner had approved the code version to run. A pack never holds a run grant (I43).
    upsertRunGrant(db, {
      extension_id: ID,
      service_id: "ext_update_pack",
      version: "1.0.0",
      tree_digest: "c".repeat(64),
      permissions_json: "{}",
      model_access: 0,
      approved_at: 1,
      credentials_json: "{}",
    });
    await runtime.deps.performUpgrade({
      ...cached,
      manifestHash: v.manifestSha256,
      packageSha256: v.packageSha256,
      entryHash: v.entryHash,
    });
    expect(installedVersion()).toBe("1.2.0");
    expect(kindOf()).toBe("starter-pack");
    expect(getRunGrant(db, ID)).toBeNull();
    // A pack's entry is its manifest (spec A3): the row stores the index's entry hash.
    expect(
      (db.query("SELECT entry_hash FROM extension WHERE id = ?").get(ID) as { entry_hash: string })
        .entry_hash,
    ).toBe(v.entryHash);
  });

  it("applies an update from a starter pack to code, and the row's kind follows it", async () => {
    // A pack with no dependencies needs a connector requirement to be a valid pack.
    const { runtime, extensionsDir } = await installedFromRegistry([
      { version: "1.0.0", starterPack: true, requires: { connectors: ["github"] } },
      { version: "1.2.0" },
    ]);
    expect(kindOf()).toBe("starter-pack");
    await runtime.deps.forcePoll();
    const cached = runtime.deps.cache.get(ID);
    if (cached === undefined) throw new Error("no update detected");
    await runtime.deps.performUpgrade(cached);
    expect(installedVersion()).toBe("1.2.0");
    expect(kindOf()).toBe("extension");
    expect(readFileSync(join(extensionsDir, ID, "dist", "index.js"), "utf8")).toContain("1.2.0");
  });

  it("detect → remove the registry → next tick: the update is no longer offered", async () => {
    const { runtime } = await installedFromRegistry();
    await runtime.deps.forcePoll();
    expect(runtime.deps.cache.get(ID)?.toVersion).toBe("1.2.0");
    deleteRegistry(db, "main");
    await runtime.deps.forcePoll();
    expect(runtime.deps.cache.list()).toEqual([]);
  });

  it("detect → the registry errors on the next tick: the update is still offered", async () => {
    const { runtime, regDir } = await installedFromRegistry();
    await runtime.deps.forcePoll();
    rmSync(join(regDir, "index.json"));
    await runtime.deps.forcePoll();
    expect(runtime.deps.cache.get(ID)?.toVersion).toBe("1.2.0");
  });

  it("detect → the registry re-signs its index without that version: the update is dropped", async () => {
    const { runtime, regDir } = await installedFromRegistry();
    await runtime.deps.forcePoll();
    const indexPath = join(regDir, "index.json");
    const index = JSON.parse(readFileSync(indexPath, "utf8")) as {
      sequence: number;
      extensions: Record<string, { versions: Record<string, unknown> }>;
    };
    delete index.extensions[ID]?.versions["1.2.0"];
    resignIndex(indexPath, { ...index, sequence: index.sequence + 1 });
    await runtime.deps.forcePoll();
    expect(runtime.deps.cache.list()).toEqual([]);
  });

  it("apply of an update whose source registry was removed is refused as source_registry_changed", async () => {
    _resetAutoUpdateMutexForTests();
    const { runtime } = await installedFromRegistry();
    await runtime.deps.forcePoll();
    deleteRegistry(db, "main");
    let asked = false;
    const res = (await dispatchAutoUpdateRpc(
      "extension.update",
      { id: ID, toVersion: "1.2.0" },
      {
        ...runtime.deps,
        gate: async () => {
          asked = true;
          return "proceed" as const;
        },
      },
    )) as { applied: boolean; reason?: string; hint?: string };
    expect(res).toMatchObject({ applied: false, reason: "source_registry_changed" });
    expect(res.hint).toContain("source registry main was removed or re-pinned");
    expect(asked).toBe(false);
    expect(installedVersion()).toBe("1.0.0");
  });

  it("performUpgrade on a stale entry fails as source_registry_changed, not a signature failure", async () => {
    const { runtime } = await installedFromRegistry();
    await runtime.deps.forcePoll();
    const cached = runtime.deps.cache.get(ID);
    if (cached === undefined) throw new Error("no update detected");
    deleteRegistry(db, "main");
    await expect(runtime.deps.performUpgrade(cached)).rejects.toThrow(/^source_registry_changed: /);
  });

  it("apply refuses when the Vault has come to trust a different publisher key since detection", async () => {
    const { runtime, vault } = await installedFromRegistry();
    await runtime.deps.forcePoll();
    const cached = runtime.deps.cache.get(ID);
    if (cached === undefined) throw new Error("no update detected");
    // The Vault no longer trusts the index's key at all (an extra trusted key would not matter).
    await evictPublisherKey(vault, "acme");
    await writePublisherKey(vault, "acme", generateEd25519Keypair().pubkey);
    await expect(runtime.deps.performUpgrade(cached)).rejects.toThrow(
      /^signature_failed: .*ERR_REGISTRY_PUBLISHER_KEY_CONFLICT/,
    );
    expect(installedVersion()).toBe("1.0.0");
  });

  it("apply refuses a version taken down after detection as trust_blocked (I48)", async () => {
    const { runtime } = await installedFromRegistry();
    await runtime.deps.forcePoll();
    const cached = runtime.deps.cache.get(ID);
    if (cached === undefined) throw new Error("no update detected");
    const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 40);
    const nimbusKey = encodeBase64(nacl.sign.keyPair.fromSeed(seed).publicKey);
    const s = await signTrustStatement(
      {
        kind: "extension.takedown",
        issuedAt: "2026-10-26T12:00:00Z",
        signerKey: nimbusKey,
        extensionId: ID,
        publisherId: "acme",
        versions: ["1.2.0"],
        // A reason quoting another phase must not be classified as that phase.
        reason: "signature_failed lookalike",
      },
      seed,
    );
    recordTrustStatements(db, [s], { kind: "feed", nimbusRootKey: nimbusKey }, 1);
    await expect(runtime.deps.performUpgrade(cached)).rejects.toThrow(
      /^trust_blocked: ERR_EXTENSION_TAKEN_DOWN/,
    );
    expect(installedVersion()).toBe("1.0.0");
    _resetAutoUpdateMutexForTests();
    const res = (await dispatchAutoUpdateRpc(
      "extension.update",
      { id: ID, toVersion: "1.2.0" },
      { ...runtime.deps, gate: async () => "proceed" as const },
    )) as { applied: boolean; reason?: string };
    expect(res).toMatchObject({ applied: false, reason: "trust_blocked" });
  });
});

describe("withUpdateAppliedHook", () => {
  const update = { id: "x.ext" } as unknown as AvailableUpdate;

  it("calls the hook with the id only after the update applied", async () => {
    const seen: string[] = [];
    await withUpdateAppliedHook(
      async () => {
        seen.push("performed");
      },
      (id) => seen.push(`applied:${id}`),
    )(update);
    expect(seen).toEqual(["performed", "applied:x.ext"]);
  });

  it("never calls it when the update failed", async () => {
    const seen: string[] = [];
    const run = withUpdateAppliedHook(
      async () => {
        throw new Error("swap_failed");
      },
      (id) => seen.push(id),
    );
    await expect(run(update)).rejects.toThrow("swap_failed");
    expect(seen).toEqual([]);
  });

  it("a throwing hook does not report a committed update as failed", async () => {
    const seen: string[] = [];
    const run = withUpdateAppliedHook(
      async () => {
        seen.push("performed");
      },
      (id) => {
        seen.push(`hook:${id}`);
        throw new Error("refresh failed");
      },
    );
    await expect(run(update)).resolves.toBeUndefined();
    expect(seen).toEqual(["performed", "hook:x.ext"]);
  });
});

describe("auto-update-init: verifiedPublisherOf (trust layer PR 3c)", () => {
  it("answers R6 from the trust store with the update's own key and source registry", async () => {
    const { signTrustStatement, publisherKeyFingerprint } = await import(
      "@nimbus-dev/registry-format"
    );
    const nacl = (await import("tweetnacl")).default;
    const { replaceCurrentVerifications } = await import("./trust/trust-store.ts");
    const root = mkdtempSync(join(tmpdir(), "nimbus-au-init-badge-"));
    try {
      const db = freshDb();
      const { deps } = createAutoUpdateRuntime(
        baseOpts(db, join(root, "extensions"), join(root, "data")),
      );
      const pubKey = Buffer.from(new Uint8Array(32).fill(9)).toString("base64");
      const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 33);
      const nimbusKey = Buffer.from(nacl.sign.keyPair.fromSeed(seed).publicKey).toString("base64");
      const cached = {
        publisherId: "acme",
        publisherKeyFingerprint: publisherKeyFingerprint(pubKey),
        sourceRegistry: "main",
        rootFingerprint: "c".repeat(32),
      } as Parameters<NonNullable<typeof deps.verifiedPublisherOf>>[0];
      expect(deps.verifiedPublisherOf?.(cached)).toBeNull();
      const vouch = await signTrustStatement(
        {
          kind: "publisher.verified",
          issuedAt: "2026-10-27T12:00:00Z",
          signerKey: nimbusKey,
          publisherId: "acme",
          keys: [pubKey],
          github: "acme-dev",
          verifiedAt: "2026-10-20T00:00:00Z",
        },
        seed,
      );
      replaceCurrentVerifications(db, [vouch], nimbusKey, 1);
      expect(deps.verifiedPublisherOf?.(cached)).toEqual({
        github: "acme-dev",
        verifiedAt: "2026-10-20T00:00:00Z",
      });
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("auto-update-init: a downgrade rewrites the dependency edges", () => {
  const ROOT = "ext.root";
  let tmpRoot: string | undefined;
  afterEach(() => {
    if (tmpRoot !== undefined) rmDirWithRetry(tmpRoot);
    tmpRoot = undefined;
  });

  /** Writes a code package (manifest + entry) to `dir`; returns its measured hashes. */
  function writePackage(dir: string, version: string, dependsOn: Record<string, unknown>) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "nimbus.extension.json"),
      JSON.stringify({ id: ROOT, version, entry: "index.js", dependsOn }),
    );
    writeFileSync(join(dir, "index.js"), `// ${version}\n`);
    return computeExtensionPackageHashes(dir);
  }

  function addRow(db: Database, id: string, version: string, asDependency: boolean): void {
    insertExtensionRow(db, {
      id,
      version,
      install_path: `/nowhere/${id}`,
      manifest_hash: "a".repeat(64),
      entry_hash: "b".repeat(64),
      enabled: 1,
      installed_at: 1,
      last_verified_at: 1,
    });
    if (asDependency) setInstalledAsDependency(db, id, true);
  }

  function edge(id: string, registry: string | null) {
    return { id, range: "^1.0.0", resolvedVersion: "1.0.0", registry };
  }

  /**
   * `ROOT` at 1.1.0 (which added `dep.new`, from registry main) with `prev/1.0.0` on disk, whose
   * manifest declares `restored`. The source registry `main` is added.
   */
  function setup(
    restored: Record<string, unknown>,
    fetch: Partial<Omit<RegistryFetchDeps, "db">> = {},
  ) {
    tmpRoot = mkdtempSync(join(tmpdir(), "nimbus-au-init-downgrade-"));
    const extensionsDir = join(tmpRoot, "extensions");
    const db = freshDb();
    const rootKey = encodeBase64(nacl.sign.keyPair().publicKey);
    insertRegistry(db, {
      name: "main",
      url: "https://main.test/",
      rootKey,
      rootFingerprint: publisherKeyFingerprint(rootKey),
      lastSequence: 0,
      lastGeneratedAt: "2026-10-01T00:00:00Z",
      addedAt: 1,
      lastIndexSha256: null,
    });
    const active = join(extensionsDir, ROOT);
    const activeHashes = writePackage(active, "1.1.0", { "dep.new": "^1.0.0" });
    insertExtensionRow(db, {
      id: ROOT,
      version: "1.1.0",
      install_path: active,
      manifest_hash: activeHashes.manifestHash,
      entry_hash: activeHashes.entryHash,
      enabled: 1,
      installed_at: 1,
      last_verified_at: 1,
    });
    const prevHashes = writePackage(
      prevVersionDir(extensionsDir, ROOT, "1.0.0"),
      "1.0.0",
      restored,
    );
    recordInstall(db, ROOT, "1.1.0", [edge("dep.new", "main")], 1);
    const update: AvailableUpdate = {
      id: ROOT,
      displayName: ROOT,
      fromVersion: "1.1.0",
      toVersion: "1.0.0",
      channel: "stable",
      changelog: "",
      publisherStatus: "unverified",
      manifestHash: prevHashes.manifestHash,
      signatureB64: "",
      entryHash: prevHashes.entryHash,
      packageSha256: "f".repeat(64),
      packageSizeBytes: 0,
      sourceRegistry: "main",
      rootFingerprint: publisherKeyFingerprint(rootKey),
      packagePath: "",
      permissionDiff: {
        network: { added: [], removed: [] },
        filesystem: { read: { added: [], removed: [] }, write: { added: [], removed: [] } },
      },
      verificationStatus: "verified",
      detectedAt: 1,
    };
    const { deps } = createAutoUpdateRuntime({
      ...baseOpts(db, extensionsDir, join(tmpRoot, "data")),
      fetch: { ...NO_NETWORK, ...fetch },
    });
    return { db, deps, update };
  }

  it("a downgrade restores the old edges and reports the added dependency as orphaned", async () => {
    const { db, deps, update } = setup({
      "dep.old": "^1.0.0",
      "dep.gone": "^2.0.0",
      "dep.elsewhere": { range: "^1.0.0", registry: "https://not-added.test/" },
    });
    addRow(db, "dep.new", "1.0.0", true);
    addRow(db, "dep.new.child", "1.0.0", true);
    recordInstall(db, "dep.new", "1.0.0", [edge("dep.new.child", "main")], 1);
    addRow(db, "dep.old", "1.0.0", true);

    const outcome = await deps.performDowngrade(update);

    expect(getExtensionVersion(db, ROOT)).toBe("1.0.0");
    expect([...forwardDeps(db, ROOT)].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      // Its registry is one the owner no longer has: recorded as null, never a failed downgrade.
      { id: "dep.elsewhere", range: "^1.0.0", registry: null },
      { id: "dep.gone", range: "^2.0.0", registry: "main" },
      { id: "dep.old", range: "^1.0.0", registry: "main" },
    ]);
    // Dependents first: removing them in this order never trips `reverse_dep_blocked`.
    expect(outcome.orphanedDependencies).toEqual(["dep.new", "dep.new.child"]);
    // A downgrade installs and removes nothing.
    expect(getExtensionVersion(db, "dep.new")).toBe("1.0.0");
    expect(getExtensionVersion(db, "dep.new.child")).toBe("1.0.0");
  });

  it("a downgrade never reports an explicitly installed or still-needed package", async () => {
    const { db, deps, update } = setup({});
    recordInstall(
      db,
      ROOT,
      "1.1.0",
      [edge("dep.new", "main"), edge("explicit", "main"), edge("shared", "main")],
      1,
    );
    addRow(db, "dep.new", "1.0.0", true);
    addRow(db, "explicit", "1.0.0", false);
    addRow(db, "shared", "1.0.0", true);
    addRow(db, "other", "1.0.0", false);
    recordInstall(db, "other", "1.0.0", [edge("shared", "main")], 1);

    const outcome = await deps.performDowngrade(update);

    expect(forwardDeps(db, ROOT)).toEqual([]);
    expect(outcome.orphanedDependencies).toEqual(["dep.new"]);
  });

  it("under the air gap, an official-registry dependency is still recorded by its name", async () => {
    const official = encodeBase64(nacl.sign.keyPair().publicKey);
    const { db, deps, update } = setup(
      { "dep.off": { range: "^1.0.0", registry: "nimbus-official" } },
      { enforceAirGap: () => true, builtin: { url: "https://official.test/", rootKey: official } },
    );
    await deps.performDowngrade(update);
    expect(forwardDeps(db, ROOT)).toEqual([
      { id: "dep.off", range: "^1.0.0", registry: "nimbus-official" },
    ]);
  });

  it("the restored edges commit with the row: a failed row write leaves the old edges", async () => {
    const { db, deps, update } = setup({ "dep.old": "^1.0.0" });
    db.exec(
      "CREATE TRIGGER fail_edges BEFORE INSERT ON extension_dependency BEGIN SELECT RAISE(ABORT, 'edge write refused'); END",
    );
    await expect(deps.performDowngrade(update)).rejects.toThrow("edge write refused");
    expect(getExtensionVersion(db, ROOT)).toBe("1.1.0");
    expect(forwardDeps(db, ROOT)).toEqual([{ id: "dep.new", range: "^1.0.0", registry: "main" }]);
  });
});

function getExtensionVersion(db: Database, id: string): string | undefined {
  return listExtensions(db).find((r) => r.id === id)?.version;
}
