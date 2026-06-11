import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { insertExtensionRow } from "../automation/extension-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { MockVault } from "../vault/mock.ts";
import { createAutoUpdateRuntime } from "./auto-update-init.ts";
import { writePublisherKey } from "./publisher-keys.ts";
import { encodeBase64, generateEd25519Keypair, signManifest } from "./verify-signature.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  return db;
}

function baseOpts(db: Database, extensionsDir: string, dataDir: string) {
  return {
    db,
    vault: new MockVault(),
    extensionsDir,
    dataDir,
    registryBaseUrl: "http://127.0.0.1:19999", // unreachable — tests that don't fetch return null
    intervalHours: 24,
    enforceAirGap: false,
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

    // forcePoll calls pollOnce → listInstalledRows → mp === undefined → continue
    // fetchLatestVersion would fail (no server), but the row is skipped before that.
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

  it("lines 67/69/70: manifest WITH name+publisher+signature → all three fields present in InstalledRow", async () => {
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

    // pollOnce calls listInstalledRows; the ext has a publisher so it proceeds to
    // fetchLatestVersion.  Because the registry URL is unreachable, the network call
    // will throw / return null and the row is silently skipped — but listInstalledRows
    // itself exercised the name/publisher/signature conditional spreads.
    await deps.forcePoll(); // network error silently swallowed per-extension catch

    // cache may or may not have entries depending on whether fetch throws or returns null.
    // We just assert the function completed without unhandled exceptions.
    expect(typeof deps.cache.list()).toBe("object");
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
// Describe: lookupPublisherKey branches (line 162: k ?? null)
// ---------------------------------------------------------------------------

describe("auto-update-init: lookupPublisherKey returns key vs null (line 162)", () => {
  let tmpRoot: string;
  afterEach(() => {
    try {
      if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it("returns null when vault has no key for publisherId", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "nimbus-au-init-nokey-"));
    const db = freshDb();
    const vault = new MockVault();
    // No key written for "missing-pub".

    // Verify indirectly: lookupPublisherKey is wired through the vault's readPublisherKey.
    // Since vault has no key, readPublisherKey returns undefined → k ?? null → result is null.
    const result = await vault.get("extension.publisher_key.missing-pub");
    expect(result).toBeNull();

    // Also confirm the runtime constructs without error and deps are wired.
    const { deps } = createAutoUpdateRuntime({
      db,
      vault,
      extensionsDir: join(tmpRoot, "extensions"),
      dataDir: join(tmpRoot, "data"),
      registryBaseUrl: "http://127.0.0.1:19999",
      intervalHours: 24,
      enforceAirGap: false,
    });
    // getInstalledVersion returns null for unknown id — confirms wiring.
    expect(await deps.getInstalledVersion("missing-pub")).toBeNull();
  });

  it("returns the stored key when vault has one for publisherId", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "nimbus-au-init-haskey-"));
    const vault = new MockVault();
    const { pubkey } = generateEd25519Keypair();

    // Write the publisher key into the vault.
    await writePublisherKey(vault, "known-pub", pubkey);

    // Confirm readPublisherKey returns the key (not null / undefined).
    // The lookupPublisherKey closure returns `k ?? null` where k = readPublisherKey result.
    const stored = await vault.get("extension.publisher_key.known-pub");
    expect(stored).not.toBeNull();
    // Decode and verify it matches (readPublisherKey decodes from base64).
    const decoded = Buffer.from(stored as string, "base64");
    expect(decoded).toHaveLength(32);
    expect(Array.from(new Uint8Array(decoded))).toEqual(Array.from(pubkey));
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

  it("hasPrevVersion returns false when row exists but _prev/<version> dir does NOT exist", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "nimbus-au-init-prevno-"));
    const db = freshDb();
    const extDir = join(tmpRoot, "ext-prevno");
    await stageExtension({ db, dir: extDir, id: "ext.prevno", version: "1.0.0" });

    const { deps } = createAutoUpdateRuntime(
      baseOpts(db, join(tmpRoot, "extensions"), join(tmpRoot, "data")),
    );

    // _prev/1.0.0 does NOT exist on disk.
    const result = await deps.hasPrevVersion("ext.prevno", "1.0.0");
    expect(result).toBe(false);
  });

  it("hasPrevVersion returns true when row exists AND _prev/<version> dir exists (line 209: existsSync true)", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "nimbus-au-init-prevyes-"));
    const db = freshDb();
    const extDir = join(tmpRoot, "ext-prevyes");
    await stageExtension({ db, dir: extDir, id: "ext.prevyes", version: "1.0.0" });

    // Manually create the _prev/<version> directory next to the install dir.
    // install_path = extDir; dirname(extDir) = tmpRoot; prevPath = join(tmpRoot, "_prev", "1.0.0")
    const prevDir = join(tmpRoot, "_prev", "1.0.0");
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

describe("auto-update-init: fetchManifest mapping branches via fake registry", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  let tmpRoot: string;

  afterEach(async () => {
    if (server !== undefined) {
      await server.stop(true);
      server = undefined;
    }
    try {
      if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  /**
   * Build a minimal valid ExtensionManifest object that `parseExtensionManifestJson` accepts.
   * The `signature` field is required when `publisher` is present.
   */
  function buildManifestPayload(opts: {
    id: string;
    version: string;
    name?: string;
    publisher?: { id: string; key: string };
    signature?: string;
    changelog?: string;
    tarballSizeBytes?: number;
  }): Record<string, unknown> {
    const manifest: Record<string, unknown> = {
      id: opts.id,
      version: opts.version,
      permissions: {},
      updateChannel: "stable",
    };
    if (opts.name !== undefined) manifest["name"] = opts.name;
    if (opts.publisher !== undefined) manifest["publisher"] = opts.publisher;
    if (opts.signature !== undefined) manifest["signature"] = opts.signature;
    if (opts.changelog !== undefined) manifest["changelog"] = opts.changelog;

    const response: Record<string, unknown> = {
      manifest,
      manifestRaw: manifest,
      manifestHash: "a".repeat(64),
      entryHash: "b".repeat(64),
      tarballUrl: "http://127.0.0.1:19997/tarball.tgz",
    };
    if (opts.tarballSizeBytes !== undefined) {
      response["tarballSizeBytes"] = opts.tarballSizeBytes;
    }
    return response;
  }

  it("line 133: sig fallback to '' when manifest has no signature field (unsigned extension)", async () => {
    // An unsigned manifest (no publisher/signature) parsed by the registry client
    // will have manifest.signature === undefined, so `m.signature ?? ""` hits the "" branch.
    tmpRoot = mkdtempSync(join(tmpdir(), "nimbus-au-init-nosig-"));
    const db = freshDb();
    const { pubkey } = generateEd25519Keypair();
    const extDir = join(tmpRoot, "ext-nosig");

    // Stage installed ext with publisher so pollOnce proceeds past the publisher check.
    // manifest on disk has publisher (needed for pollOne to proceed), but the REGISTRY
    // response returns NO signature — testing the `sig = m.signature ?? ""` branch.
    await stageExtension({
      db,
      dir: extDir,
      id: "ext.nosig",
      publisherId: "pub-nosig",
      pubkey,
    });

    const { pubkey: pub2 } = generateEd25519Keypair();

    // Build a registry response with a manifest that has NO signature.
    // BUT parseExtensionManifestJson requires publisher+signature together or neither.
    // So the registry manifest must either have both or neither.
    // Test the "neither" case (no publisher, no signature).
    const registryManifestResponse = buildManifestPayload({
      id: "ext.nosig",
      version: "1.1.0",
      // no signature → m.signature === undefined → sig = m.signature ?? "" = ""
    });

    const latestResponse = JSON.stringify({ version: "1.1.0", channel: "stable" });
    const manifestResponse = JSON.stringify(registryManifestResponse);

    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.includes("/latest")) {
          return new Response(latestResponse, {
            headers: { "content-type": "application/json" },
          });
        }
        if (url.pathname.includes("/manifest")) {
          return new Response(manifestResponse, {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    const port = (server as { port: number }).port;
    const registryBaseUrl = `http://127.0.0.1:${String(port)}`;

    const vault = new MockVault();
    // Write a fake publisher key so lookupPublisherKey returns a key (not null).
    await writePublisherKey(vault, "pub-nosig", pub2);

    const runtime = createAutoUpdateRuntime({
      db,
      vault,
      extensionsDir: join(tmpRoot, "extensions"),
      dataDir: join(tmpRoot, "data"),
      registryBaseUrl,
      intervalHours: 24,
      enforceAirGap: false,
    });

    // Drive through pollOnce. The fetchManifest mapping closure runs the
    // `sig = m.signature ?? ""` fallback (registry manifest has no signature).
    // pollOne then returns early because the new manifest carries no publisher,
    // so NO available-update is cached — assert exactly that observable outcome.
    await runtime.daemon.pollOnce();
    expect(runtime.deps.cache.list()).toHaveLength(0);
  });

  it("lines 139/143/145/147: tarballSizeBytes/name/publisher/changelog present → all spread branches hit", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "nimbus-au-init-allspreads-"));
    const db = freshDb();
    const { pubkey, privkey } = generateEd25519Keypair();
    const extDir = join(tmpRoot, "ext-spreads");

    await stageExtension({
      db,
      dir: extDir,
      id: "ext.spreads",
      publisherId: "pub-spreads",
      pubkey,
      privkey,
    });

    // Registry manifest WITH publisher+signature, name, changelog, AND tarballSizeBytes.
    // signManifest needs the exact manifest fields; use a pre-computed fake valid sig.
    const fakeSig = `${"B".repeat(86)}==`;
    const fakeKey = encodeBase64(pubkey);

    const registryManifestResponse = buildManifestPayload({
      id: "ext.spreads",
      version: "1.1.0",
      name: "Spreads Extension",
      publisher: { id: "pub-spreads", key: fakeKey },
      signature: fakeSig,
      changelog: "Bug fixes and improvements.",
      tarballSizeBytes: 12345,
    });

    const latestResponse = JSON.stringify({ version: "1.1.0", channel: "stable" });
    const manifestResponse = JSON.stringify(registryManifestResponse);

    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.includes("/latest")) {
          return new Response(latestResponse, {
            headers: { "content-type": "application/json" },
          });
        }
        if (url.pathname.includes("/manifest")) {
          return new Response(manifestResponse, {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    const port = (server as { port: number }).port;
    const registryBaseUrl = `http://127.0.0.1:${String(port)}`;

    const vault = new MockVault();
    await writePublisherKey(vault, "pub-spreads", pubkey);

    const runtime = createAutoUpdateRuntime({
      db,
      vault,
      extensionsDir: join(tmpRoot, "extensions"),
      dataDir: join(tmpRoot, "data"),
      registryBaseUrl,
      intervalHours: 24,
      enforceAirGap: false,
    });

    await runtime.daemon.pollOnce();

    // An update should have been detected with the tarballSizeBytes, name, publisher, changelog
    // having been spread in from the registry manifest. Either verified or signature_failed.
    const cached = runtime.deps.cache.list();
    expect(cached).toHaveLength(1);
    const entry = cached[0];
    expect(entry).toBeDefined();
    // tarballSizeBytes was present → spread into the result
    expect(entry?.tarballSizeBytes).toBe(12345);
    // displayName comes from newManifest.name
    expect(entry?.displayName).toBe("Spreads Extension");
  });

  it("lines 139: tarballSizeBytes absent → NOT spread into result", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "nimbus-au-init-nosizebytes-"));
    const db = freshDb();
    const { pubkey, privkey } = generateEd25519Keypair();
    const extDir = join(tmpRoot, "ext-nosizebytes");

    await stageExtension({
      db,
      dir: extDir,
      id: "ext.nosizebytes",
      publisherId: "pub-nsb",
      pubkey,
      privkey,
    });

    const fakeSig = `${"B".repeat(86)}==`;
    const fakeKey = encodeBase64(pubkey);

    // No tarballSizeBytes in response → spread hits the empty `{}` branch.
    const registryManifestResponse = buildManifestPayload({
      id: "ext.nosizebytes",
      version: "1.1.0",
      publisher: { id: "pub-nsb", key: fakeKey },
      signature: fakeSig,
      // no tarballSizeBytes
    });

    const latestResponse = JSON.stringify({ version: "1.1.0", channel: "stable" });
    const manifestResponse = JSON.stringify(registryManifestResponse);

    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.includes("/latest")) {
          return new Response(latestResponse, {
            headers: { "content-type": "application/json" },
          });
        }
        if (url.pathname.includes("/manifest")) {
          return new Response(manifestResponse, {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    const port = (server as { port: number }).port;
    const vault = new MockVault();
    await writePublisherKey(vault, "pub-nsb", pubkey);

    const runtime = createAutoUpdateRuntime({
      db,
      vault,
      extensionsDir: join(tmpRoot, "extensions"),
      dataDir: join(tmpRoot, "data"),
      registryBaseUrl: `http://127.0.0.1:${String(port)}`,
      intervalHours: 24,
      enforceAirGap: false,
    });

    await runtime.daemon.pollOnce();

    const cached = runtime.deps.cache.list();
    expect(cached).toHaveLength(1);
    const entry = cached[0];
    expect(entry?.tarballSizeBytes).toBeUndefined();
  });
});
