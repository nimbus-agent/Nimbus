import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  publisherKeyFingerprint,
  signTrustStatement,
  trustStatementId,
} from "@nimbus-dev/registry-format";
import nacl from "tweetnacl";
import {
  installStarterPackFixture,
  PACK_FIXTURE,
} from "../../test/helpers/starter-pack-fixture.ts";
import {
  insertExtensionRow,
  listExtensions,
  setExtensionEnabled,
  setExtensionTreeDigest,
} from "../automation/extension-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { MockVault } from "../vault/mock.ts";
import { approveExtensionRun } from "./approve-run.ts";
import type { ContinuityEntry } from "./continuity/continuity-table.ts";
import { serializeRunCredentials } from "./extension-credentials.ts";
import { type ExtensionRunGrantEnv, serializeRunGrants } from "./extension-run-grants.ts";
import { signatureDisabledRegistry } from "./hard-disable.ts";
import { installExtensionFromLocalDirectory } from "./install-from-local.ts";
import { evictPublisherKey } from "./publisher-keys.ts";
import { ExtensionRunGrantError, type ExtensionRunGrantErrorCode } from "./run-grant-error.ts";
import { getRunGrant, upsertRunGrant } from "./run-grant-store.ts";
import { computeExtensionTreeDigest } from "./tree-digest.ts";
import { recordTrustStatements, type StatementSource } from "./trust/trust-store.ts";
import {
  readVerifiedExtensionForEval,
  readVerifiedExtensionForSpawn,
} from "./verified-extension.ts";
import { encodeBase64, generateEd25519Keypair, signManifest } from "./verify-signature.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
  signatureDisabledRegistry.reset();
});

type Fixture = {
  db: Database;
  root: string;
  installPath: string;
  env: ExtensionRunGrantEnv;
  vault: MockVault;
  id: string;
};

function freshRoot(): { db: Database; root: string; env: ExtensionRunGrantEnv } {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "nimbus-verified-ext-")));
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  cleanups.push(() => db.close());
  mkdirSync(join(root, "outside"), { recursive: true });
  mkdirSync(join(root, "data"), { recursive: true });
  const env: ExtensionRunGrantEnv = {
    platform: process.platform,
    protectedRoots: [join(root, "data"), join(root, "config")],
    runtimeReadPaths: [join(root, "bun-bin")],
    realpath: (p) => realpathSync.native(p),
  };
  return { db, root, env };
}

/**
 * Installs a real extension through the installer and approves it through `approveExtensionRun`,
 * so the row and the grant are exactly what production writes. `signed` installs a publisher-signed
 * manifest with its key cached in the returned Vault.
 */
async function setup(
  opts: {
    id?: string;
    manifest?: (root: string) => Record<string, unknown>;
    signed?: boolean;
    approve?: boolean;
  } = {},
): Promise<Fixture> {
  const id = opts.id ?? "com.example.spawn";
  const { db, root, env } = freshRoot();
  const vault = new MockVault();
  const src = join(root, "src");
  mkdirSync(join(src, "dist"), { recursive: true });
  const manifest: Record<string, unknown> = {
    id,
    version: "1.0.0",
    entry: "dist/index.js",
    ...(opts.manifest?.(root) ?? {}),
  };
  let publisherKeyPath: string | undefined;
  if (opts.signed === true) {
    const kp = generateEd25519Keypair();
    manifest["publisher"] = { id: "test-pub", key: encodeBase64(kp.pubkey) };
    manifest["signature"] = await signManifest(manifest, kp.privkey);
    publisherKeyPath = join(root, "pub.key");
    writeFileSync(publisherKeyPath, `${encodeBase64(kp.pubkey)}\n`);
  }
  writeFileSync(join(src, "nimbus.extension.json"), JSON.stringify(manifest));
  writeFileSync(join(src, "dist", "index.js"), "export {};\n");
  writeFileSync(join(src, "dist", "chunk.js"), "export const x = 1;\n");
  const extensionsDir = join(root, "data", "extensions");
  await installExtensionFromLocalDirectory({
    db,
    extensionsDir,
    sourcePath: src,
    approve: async () => true,
    ...(publisherKeyPath === undefined
      ? {}
      : {
          vault,
          publisherKeyPath,
        }),
  });
  if (opts.approve !== false) {
    await approveExtensionRun(id, {
      db,
      env,
      gate: async () => true,
      runtimeEnabled: true,
      now: () => 1,
    });
  }
  return { db, root, installPath: join(extensionsDir, id), env, vault, id };
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Writes an install dir and its row + grant by hand, bypassing the installer, for shapes the
 * installer itself refuses (an entry outside the tree, a publisher with no signature) or rows it
 * never writes (no tree digest). Every hash is computed over the real bytes, so only the property
 * under test is wrong.
 */
function manualInstall(
  manifest: Record<string, unknown>,
  opts: { entryFile: (installPath: string, root: string) => string; noDigest?: boolean },
): Fixture {
  const { db, root, env } = freshRoot();
  const id = String(manifest["id"]);
  const installPath = join(root, "data", "extensions", id);
  mkdirSync(join(installPath, "dist"), { recursive: true });
  writeFileSync(join(installPath, "nimbus.extension.json"), JSON.stringify(manifest));
  const entryFile = opts.entryFile(installPath, root);
  mkdirSync(dirname(entryFile), { recursive: true });
  writeFileSync(entryFile, "export {};\n");
  const manifestBytes = readFileSync(join(installPath, "nimbus.extension.json"));
  const treeDigest = computeExtensionTreeDigest(installPath);
  insertExtensionRow(db, {
    id,
    version: String(manifest["version"]),
    install_path: installPath,
    manifest_hash: sha256Hex(manifestBytes),
    entry_hash: sha256Hex(readFileSync(entryFile)),
    installed_at: 1,
    last_verified_at: 1,
    tree_digest: opts.noDigest === true ? null : treeDigest,
  });
  // Hand-built manifests declare no permissions, so the approved grant is the empty one. Not
  // parsed here: some of these manifests are ones the parser itself refuses.
  upsertRunGrant(db, {
    extension_id: id,
    service_id: `ext_${id.replaceAll(".", "_")}`,
    version: String(manifest["version"]),
    tree_digest: treeDigest,
    permissions_json: serializeRunGrants({ network: [], read: [], write: [] }),
    model_access: 0,
    approved_at: 1,
    credentials_json: "{}",
  });
  return { db, root, installPath, env, vault: new MockVault(), id };
}

async function expectCode(
  p: Promise<unknown>,
  code: ExtensionRunGrantErrorCode,
  message?: RegExp,
): Promise<void> {
  let caught: unknown;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(ExtensionRunGrantError);
  expect((caught as ExtensionRunGrantError).code).toBe(code);
  if (message !== undefined) expect((caught as ExtensionRunGrantError).message).toMatch(message);
}

const deps = (f: Fixture) => ({ db: f.db, vault: f.vault, env: f.env });

describe("readVerifiedExtensionForSpawn", () => {
  test("happy path: entry inside the realpath install, grants equal the stored grant", async () => {
    const f = await setup({
      manifest: (root) => ({
        permissions: {
          network: ["api.example.com"],
          filesystem: { read: [join(root, "outside")], write: [] },
        },
      }),
    });
    const v = await readVerifiedExtensionForSpawn(f.id, deps(f));
    const install = realpathSync.native(f.installPath);
    expect(v.extensionId).toBe(f.id);
    expect(v.serviceId).toBe("ext_com_example_spawn");
    expect(v.version).toBe("1.0.0");
    expect(v.installPath).toBe(install);
    expect(v.entryPath).toBe(join(install, "dist", "index.js"));
    const stored = getRunGrant(f.db, f.id);
    expect(stored).not.toBeNull();
    expect(v.grants).toEqual(JSON.parse(stored?.permissions_json ?? "null"));
    expect(v.grants.read).toEqual([join(f.root, "outside")]);
  });

  test("a publisher-signed extension whose key is still cached passes", async () => {
    const f = await setup({ signed: true });
    const v = await readVerifiedExtensionForSpawn(f.id, deps(f));
    expect(v.extensionId).toBe(f.id);
  });

  test("1a: an unknown id refuses NOT_FOUND", async () => {
    const f = await setup();
    await expectCode(
      readVerifiedExtensionForSpawn("com.example.nope", deps(f)),
      "ERR_EXTENSION_NOT_FOUND",
    );
  });

  test("1b: a disabled extension refuses RUN_DISABLED", async () => {
    const f = await setup();
    setExtensionEnabled(f.db, f.id, false);
    await expectCode(readVerifiedExtensionForSpawn(f.id, deps(f)), "ERR_EXTENSION_RUN_DISABLED");
  });

  test("order: disabled is reported before a missing grant", async () => {
    const f = await setup({ approve: false });
    setExtensionEnabled(f.db, f.id, false);
    await expectCode(readVerifiedExtensionForSpawn(f.id, deps(f)), "ERR_EXTENSION_RUN_DISABLED");
  });

  test("2: an unapproved extension refuses RUN_NOT_APPROVED", async () => {
    const f = await setup({ approve: false });
    await expectCode(
      readVerifiedExtensionForSpawn(f.id, deps(f)),
      "ERR_EXTENSION_RUN_NOT_APPROVED",
    );
  });

  test("3a: a startup signature failure refuses RUN_UNVERIFIED", async () => {
    const f = await setup();
    signatureDisabledRegistry.mark(f.id, "signature_failed");
    await expectCode(readVerifiedExtensionForSpawn(f.id, deps(f)), "ERR_EXTENSION_RUN_UNVERIFIED");
  });

  test("3b: an entry edited after install refuses RUN_UNVERIFIED (strict hash)", async () => {
    const f = await setup();
    writeFileSync(join(f.installPath, "dist", "index.js"), "evil();\n");
    await expectCode(readVerifiedExtensionForSpawn(f.id, deps(f)), "ERR_EXTENSION_RUN_UNVERIFIED");
  });

  test("4: a row with no tree digest refuses RUN_NO_DIGEST", async () => {
    const f = manualInstall(
      { id: "com.example.nodigest", version: "1.0.0", entry: "dist/index.js" },
      { entryFile: (ip) => join(ip, "dist", "index.js"), noDigest: true },
    );
    await expectCode(readVerifiedExtensionForSpawn(f.id, deps(f)), "ERR_EXTENSION_RUN_NO_DIGEST");
  });

  test("5a: a sibling file edited after approval refuses RUN_TREE_CHANGED", async () => {
    const f = await setup();
    writeFileSync(join(f.installPath, "dist", "chunk.js"), "evil();\n");
    await expectCode(
      readVerifiedExtensionForSpawn(f.id, deps(f)),
      "ERR_EXTENSION_RUN_TREE_CHANGED",
    );
  });

  test("5b: a file added after approval refuses RUN_TREE_CHANGED", async () => {
    const f = await setup();
    writeFileSync(join(f.installPath, "dist", "added.js"), "evil();\n");
    await expectCode(
      readVerifiedExtensionForSpawn(f.id, deps(f)),
      "ERR_EXTENSION_RUN_TREE_CHANGED",
    );
  });

  test("5c: a grant approved over a different digest refuses RUN_TREE_CHANGED", async () => {
    const f = await setup();
    const g = getRunGrant(f.db, f.id);
    if (g === null) throw new Error("no grant");
    upsertRunGrant(f.db, { ...g, tree_digest: "0".repeat(64) });
    await expectCode(
      readVerifiedExtensionForSpawn(f.id, deps(f)),
      "ERR_EXTENSION_RUN_TREE_CHANGED",
    );
  });

  test("5c2: a row digest that no longer matches the live tree refuses RUN_TREE_CHANGED", async () => {
    const f = await setup();
    setExtensionTreeDigest(f.db, f.id, "0".repeat(64));
    await expectCode(
      readVerifiedExtensionForSpawn(f.id, deps(f)),
      "ERR_EXTENSION_RUN_TREE_CHANGED",
    );
  });

  test("5d: a grant approved for a different version refuses RUN_CHANGED", async () => {
    const f = await setup();
    const g = getRunGrant(f.db, f.id);
    if (g === null) throw new Error("no grant");
    upsertRunGrant(f.db, { ...g, version: "0.9.0" });
    await expectCode(readVerifiedExtensionForSpawn(f.id, deps(f)), "ERR_EXTENSION_RUN_CHANGED");
  });

  test("6a: a signed extension whose publisher key left the Vault refuses RUN_UNVERIFIED", async () => {
    const f = await setup({ signed: true });
    await evictPublisherKey(f.vault, "test-pub");
    await expectCode(readVerifiedExtensionForSpawn(f.id, deps(f)), "ERR_EXTENSION_RUN_UNVERIFIED");
  });

  test("6b: a cached key that no longer matches the manifest's refuses RUN_UNVERIFIED", async () => {
    const f = await setup({ signed: true });
    // Swap what the Vault holds under the fingerprint the row recorded, and the legacy key.
    const fp = listExtensions(f.db).find((r) => r.id === f.id)?.publisher_key_fingerprint ?? "";
    const other = encodeBase64(generateEd25519Keypair().pubkey);
    await f.vault.set(`extension.publisher_keyfp.${fp}.test-pub`, other);
    await f.vault.set("extension.publisher_key.test-pub", other);
    await expectCode(readVerifiedExtensionForSpawn(f.id, deps(f)), "ERR_EXTENSION_RUN_UNVERIFIED");
  });

  test("6c: a publisher with no signature refuses RUN_UNVERIFIED (typed), never runs as unsigned", async () => {
    const kp = generateEd25519Keypair();
    const f = manualInstall(
      {
        id: "com.example.nosig",
        version: "1.0.0",
        entry: "dist/index.js",
        publisher: { id: "test-pub", key: encodeBase64(kp.pubkey) },
      },
      { entryFile: (ip) => join(ip, "dist", "index.js") },
    );
    await f.vault.set("extension.publisher_key.test-pub", encodeBase64(kp.pubkey));
    await expectCode(readVerifiedExtensionForSpawn(f.id, deps(f)), "ERR_EXTENSION_RUN_UNVERIFIED");
  });

  // Step 6 re-reads the manifest bytes rather than trusting step 4's read. The tree digest (step 5)
  // runs between the two, so it is where these tests change the manifest after step 4 passed.
  const digestThen = (change: () => void) => (root: string) => {
    const digest = computeExtensionTreeDigest(root);
    change();
    return digest;
  };

  test("6d: a manifest deleted after step 4 refuses RUN_UNVERIFIED at the signature re-read", async () => {
    const f = await setup({ signed: true });
    const manifestPath = join(f.installPath, "nimbus.extension.json");
    await expectCode(
      readVerifiedExtensionForSpawn(f.id, {
        ...deps(f),
        treeDigest: digestThen(() => rmSync(manifestPath)),
      }),
      "ERR_EXTENSION_RUN_UNVERIFIED",
      /could not be read/,
    );
  });

  test("6e: a manifest rewritten after step 4 refuses RUN_UNVERIFIED at the signature re-read", async () => {
    const f = await setup({ signed: true });
    const manifestPath = join(f.installPath, "nimbus.extension.json");
    const rewritten = readFileSync(manifestPath, "utf8").replace('"1.0.0"', '"1.0.0" ');
    await expectCode(
      readVerifiedExtensionForSpawn(f.id, {
        ...deps(f),
        treeDigest: digestThen(() => writeFileSync(manifestPath, rewritten)),
      }),
      "ERR_EXTENSION_RUN_UNVERIFIED",
      /changed during verification/,
    );
  });

  test("7: an entry outside the install tree refuses ENTRY_OUTSIDE", async () => {
    const f = manualInstall(
      { id: "com.example.escape", version: "1.0.0", entry: "../outside.js" },
      { entryFile: (ip) => join(ip, "..", "outside.js") },
    );
    await expectCode(readVerifiedExtensionForSpawn(f.id, deps(f)), "ERR_EXTENSION_ENTRY_OUTSIDE");
  });

  test("7b: a POSIX-absolute entry refuses ENTRY_OUTSIDE before any join", async () => {
    // `join` re-roots "/x.js" under the install path, so steps 1–6 pass over a real file there; the
    // refusal must come from the explicit absolute check, not from containment.
    const f = manualInstall(
      { id: "com.example.abs", version: "1.0.0", entry: "/x.js" },
      { entryFile: (ip) => join(ip, "x.js") },
    );
    await expectCode(readVerifiedExtensionForSpawn(f.id, deps(f)), "ERR_EXTENSION_ENTRY_OUTSIDE");
  });

  // 7c/7d write the entry file where steps 3–6 look for it, so step 7 is the step that refuses.
  // The manifest parser rewrites every backslash in `entry` to `/` (`manifest.ts` `parseEntry`) and
  // step 3 joins THAT with the host's path rules. Writing the file under the raw backslash spelling
  // names a different file on POSIX, where a backslash is an ordinary filename character, so step 3
  // refused ERR_EXTENSION_RUN_UNVERIFIED there before step 7 ever ran. The message is asserted too,
  // pinning the refusal to step 7's absolute-path check rather than its later containment check.
  const asParsed = (entry: string): string => entry.replaceAll("\\", "/");

  test("7c: a UNC entry refuses ENTRY_OUTSIDE (win32 path rules, injected)", async () => {
    const entry = String.raw`\\server\share\x.js`;
    const f = manualInstall(
      { id: "com.example.unc", version: "1.0.0", entry },
      { entryFile: (ip) => join(ip, asParsed(entry)) },
    );
    await expectCode(
      readVerifiedExtensionForSpawn(f.id, { ...deps(f), env: { ...f.env, platform: "win32" } }),
      "ERR_EXTENSION_ENTRY_OUTSIDE",
      /is an absolute path/,
    );
  });

  // `C:/x.js` joined under the install path needs a directory named `C:`, which a Windows host
  // cannot create, so this is a POSIX-host test of the win32 path rules.
  test.skipIf(process.platform === "win32")(
    "7d: a drive-letter entry refuses ENTRY_OUTSIDE (win32 path rules, injected)",
    async () => {
      const entry = String.raw`C:\x.js`;
      const f = manualInstall(
        { id: "com.example.drive", version: "1.0.0", entry },
        { entryFile: (ip) => join(ip, asParsed(entry)) },
      );
      await expectCode(
        readVerifiedExtensionForSpawn(f.id, { ...deps(f), env: { ...f.env, platform: "win32" } }),
        "ERR_EXTENSION_ENTRY_OUTSIDE",
        /is an absolute path/,
      );
    },
  );

  test("7e: an entry through a symlinked directory refuses RUN_TREE_CHANGED at step 5", async () => {
    const f = manualInstall(
      { id: "com.example.symdir", version: "1.0.0", entry: "dist/index.js" },
      { entryFile: (ip) => join(ip, "dist", "index.js") },
    );
    // Same bytes, so the manifest + entry hashes (step 3) still pass; only the tree walk sees the link.
    const elsewhere = join(f.root, "outside", "dist");
    cpSync(join(f.installPath, "dist"), elsewhere, { recursive: true });
    rmSync(join(f.installPath, "dist"), { recursive: true, force: true });
    symlinkSync(elsewhere, join(f.installPath, "dist"), "junction");
    await expectCode(
      readVerifiedExtensionForSpawn(f.id, deps(f)),
      "ERR_EXTENSION_RUN_TREE_CHANGED",
    );
  });

  test("2b: a grant whose service id breaks the pattern refuses RUN_CHANGED", async () => {
    const f = await setup();
    const g = getRunGrant(f.db, f.id);
    if (g === null) throw new Error("no grant");
    upsertRunGrant(f.db, { ...g, service_id: "ext_../evil" });
    await expectCode(readVerifiedExtensionForSpawn(f.id, deps(f)), "ERR_EXTENSION_RUN_CHANGED");
  });

  test("6d: a Vault read failure refuses RUN_UNVERIFIED with the cause in the message", async () => {
    const f = await setup({ signed: true });
    const vault = new MockVault();
    vault.get = async () => {
      throw new Error("keychain locked");
    };
    let caught: unknown;
    try {
      await readVerifiedExtensionForSpawn(f.id, { ...deps(f), vault });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ExtensionRunGrantError);
    expect((caught as ExtensionRunGrantError).code).toBe("ERR_EXTENSION_RUN_UNVERIFIED");
    expect((caught as Error).message).toContain("keychain locked");
  });

  test("8a: a declared read path deleted after approval refuses GRANT_PATH_MISSING", async () => {
    const f = await setup({
      manifest: (root) => ({
        permissions: { network: [], filesystem: { read: [join(root, "outside")], write: [] } },
      }),
    });
    rmSync(join(f.root, "outside"), { recursive: true, force: true });
    await expectCode(
      readVerifiedExtensionForSpawn(f.id, deps(f)),
      "ERR_EXTENSION_GRANT_PATH_MISSING",
    );
  });

  test("8b: grants that no longer re-resolve to the stored grant refuse RUN_CHANGED", async () => {
    const f = await setup();
    const g = getRunGrant(f.db, f.id);
    if (g === null) throw new Error("no grant");
    upsertRunGrant(f.db, {
      ...g,
      permissions_json: serializeRunGrants({ network: ["x.example.com"], read: [], write: [] }),
    });
    await expectCode(readVerifiedExtensionForSpawn(f.id, deps(f)), "ERR_EXTENSION_RUN_CHANGED");
  });

  test("re-hashes the tree on every call, never a cache", async () => {
    const f = await setup();
    let calls = 0;
    const treeDigest = (root: string): string => {
      calls++;
      return computeExtensionTreeDigest(root);
    };
    await readVerifiedExtensionForSpawn(f.id, { ...deps(f), treeDigest });
    await readVerifiedExtensionForSpawn(f.id, { ...deps(f), treeDigest });
    expect(calls).toBe(2);
  });
});

describe("readVerifiedExtensionForSpawn — credentials (step 9)", () => {
  const withToken = () => ({ credentials: { token: { env: "READWISE_TOKEN" } } });

  function publisherKeyOf(f: Fixture): string {
    const m = JSON.parse(readFileSync(join(f.installPath, "nimbus.extension.json"), "utf8")) as {
      publisher?: { key?: string };
    };
    return m.publisher?.key ?? "";
  }

  function entryFor(f: Fixture, fp: string): ContinuityEntry {
    return {
      legacyServiceId: "readwise",
      extensionId: f.id,
      publisherKey: publisherKeyOf(f),
      sourceRootFingerprint: fp,
      credentials: { token: "readwise.token" },
      expectedPermissions: { network: [], read: [], write: [] },
      itemTypes: [],
    };
  }

  test("happy path: the re-resolved credentials equal the stored grant and are exposed", async () => {
    const f = await setup({ manifest: withToken });
    const v = await readVerifiedExtensionForSpawn(f.id, deps(f));
    expect(v.credentials).toEqual({
      token: { env: "READWISE_TOKEN", vaultKey: "ext.ext_com_example_spawn.token" },
    });
    expect(serializeRunCredentials(v.credentials)).toBe(
      getRunGrant(f.db, f.id)?.credentials_json ?? "",
    );
  });

  test("no declared credentials resolve to {}", async () => {
    const f = await setup();
    const v = await readVerifiedExtensionForSpawn(f.id, deps(f));
    expect(v.credentials).toEqual({});
  });

  test("manifest adds a credential after approval -> ERR_EXTENSION_RUN_CHANGED", async () => {
    const f = await setup();
    // The manifest gains a credential, and every OTHER record is brought into line with it (row
    // hashes, row digest, approved digest), so the credential check is the only one that can fire.
    const manifestPath = join(f.installPath, "nimbus.extension.json");
    const m = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    writeFileSync(manifestPath, JSON.stringify({ ...m, ...withToken() }));
    f.db.run("UPDATE extension SET manifest_hash = ? WHERE id = ?", [
      sha256Hex(readFileSync(manifestPath)),
      f.id,
    ]);
    const digest = computeExtensionTreeDigest(f.installPath);
    setExtensionTreeDigest(f.db, f.id, digest);
    const g = getRunGrant(f.db, f.id);
    if (g === null) throw new Error("no grant");
    upsertRunGrant(f.db, { ...g, tree_digest: digest });
    await expectCode(
      readVerifiedExtensionForSpawn(f.id, deps(f)),
      "ERR_EXTENSION_RUN_CHANGED",
      /credentials/,
    );
  });

  test("a stored credential mapping that differs from the re-resolved one refuses RUN_CHANGED", async () => {
    const f = await setup({ manifest: withToken });
    const g = getRunGrant(f.db, f.id);
    if (g === null) throw new Error("no grant");
    upsertRunGrant(f.db, {
      ...g,
      credentials_json: serializeRunCredentials({
        token: { env: "READWISE_TOKEN", vaultKey: "github.pat" },
      }),
    });
    await expectCode(readVerifiedExtensionForSpawn(f.id, deps(f)), "ERR_EXTENSION_RUN_CHANGED");
  });

  test("a continuity binding resolved at spawn must match the one approved", async () => {
    const f = await setup({ manifest: withToken, signed: true, approve: false });
    f.db.run("UPDATE extension SET source_root_fingerprint = 'root-fp' WHERE id = ?", [f.id]);
    const table = [entryFor(f, "root-fp")];
    await approveExtensionRun(f.id, {
      db: f.db,
      env: f.env,
      gate: async () => true,
      runtimeEnabled: true,
      now: () => 1,
      continuityTable: table,
    });
    // Bound at approval and at spawn: the legacy key is what the spawn reads.
    const v = await readVerifiedExtensionForSpawn(f.id, { ...deps(f), continuityTable: table });
    expect(v.credentials).toEqual({ token: { env: "READWISE_TOKEN", vaultKey: "readwise.token" } });
    // The same grant read against a table that no longer binds it (production's empty default)
    // re-resolves to the extension's own key, which is not what was approved.
    await expectCode(readVerifiedExtensionForSpawn(f.id, deps(f)), "ERR_EXTENSION_RUN_CHANGED");
    // And a source whose root fingerprint changed after approval no longer binds either.
    f.db.run("UPDATE extension SET source_root_fingerprint = 'other' WHERE id = ?", [f.id]);
    await expectCode(
      readVerifiedExtensionForSpawn(f.id, { ...deps(f), continuityTable: table }),
      "ERR_EXTENSION_RUN_CHANGED",
    );
  });
});

describe("readVerifiedExtensionForSpawn — trust blocks (I48)", () => {
  const NIMBUS_SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 11);
  const NIMBUS_KEY = encodeBase64(nacl.sign.keyPair.fromSeed(NIMBUS_SEED).publicKey);
  const FEED: StatementSource = { kind: "feed", nimbusRootKey: NIMBUS_KEY };

  function installedPublisherKey(f: Fixture): string {
    const m = JSON.parse(readFileSync(join(f.installPath, "nimbus.extension.json"), "utf8")) as {
      publisher: { key: string };
    };
    return m.publisher.key;
  }

  async function block(
    f: Fixture,
    kind: "key.revoke" | "extension.takedown",
    reason = "bad",
  ): Promise<string> {
    const s =
      kind === "key.revoke"
        ? await signTrustStatement(
            {
              kind,
              issuedAt: "2026-10-26T12:00:00Z",
              signerKey: NIMBUS_KEY,
              publisherId: "test-pub",
              keyFingerprint: publisherKeyFingerprint(installedPublisherKey(f)),
              reason,
            },
            NIMBUS_SEED,
          )
        : await signTrustStatement(
            {
              kind,
              issuedAt: "2026-10-26T12:00:00Z",
              signerKey: NIMBUS_KEY,
              extensionId: f.id,
              publisherId: "test-pub",
              versions: "*",
              reason,
            },
            NIMBUS_SEED,
          );
    expect(recordTrustStatements(f.db, [s], FEED, 1).inserted).toBe(1);
    return trustStatementId(s);
  }

  function acknowledge(f: Fixture, ids: string[]): void {
    const g = getRunGrant(f.db, f.id);
    if (g === null) throw new Error("no grant");
    upsertRunGrant(f.db, { ...g, trust_ack_json: JSON.stringify(ids) });
  }

  test("a taken-down extension refuses TAKEN_DOWN before its tree is hashed", async () => {
    const f = await setup({ signed: true });
    await block(f, "extension.takedown", "malware found");
    let hashed = 0;
    const treeDigest = (root: string): string => {
      hashed++;
      return computeExtensionTreeDigest(root);
    };
    await expectCode(
      readVerifiedExtensionForSpawn(f.id, { ...deps(f), treeDigest }),
      "ERR_EXTENSION_TAKEN_DOWN",
      /malware found.*nimbus extension approve/,
    );
    expect(hashed).toBe(0);
  });

  test("a revoked key refuses KEY_REVOKED although the signature is valid", async () => {
    const f = await setup({ signed: true });
    await block(f, "key.revoke", "key leaked");
    await expectCode(
      readVerifiedExtensionForSpawn(f.id, deps(f)),
      "ERR_EXTENSION_KEY_REVOKED",
      /publisher key revoked by Nimbus.*key leaked/,
    );
  });

  test("a revocation is reported before a takedown, and also before the tree is hashed", async () => {
    const f = await setup({ signed: true });
    await block(f, "extension.takedown");
    await block(f, "key.revoke", "key leaked");
    let hashed = 0;
    const treeDigest = (root: string): string => {
      hashed++;
      return computeExtensionTreeDigest(root);
    };
    await expectCode(
      readVerifiedExtensionForSpawn(f.id, { ...deps(f), treeDigest }),
      "ERR_EXTENSION_KEY_REVOKED",
    );
    expect(hashed).toBe(0);
  });

  test("a revocation of the key the Vault holds NOW refuses at step 6 even if the row recorded another", async () => {
    const f = await setup({ signed: true });
    f.db.run("UPDATE extension SET publisher_key_fingerprint = ? WHERE id = ?", [
      "0".repeat(32),
      f.id,
    ]);
    await block(f, "key.revoke", "vault key leaked");
    await expectCode(
      readVerifiedExtensionForSpawn(f.id, deps(f)),
      "ERR_EXTENSION_KEY_REVOKED",
      /vault key leaked/,
    );
  });

  test("blocks the grant acknowledged let it run; a NEW block refuses again", async () => {
    const f = await setup({ signed: true });
    const ids = [await block(f, "key.revoke"), await block(f, "extension.takedown")];
    acknowledge(f, ids);
    expect((await readVerifiedExtensionForSpawn(f.id, deps(f))).extensionId).toBe(f.id);
    await block(f, "extension.takedown", "a second report");
    await expectCode(
      readVerifiedExtensionForSpawn(f.id, deps(f)),
      "ERR_EXTENSION_TAKEN_DOWN",
      /a second report/,
    );
  });

  test("an unsigned extension is never blocked", async () => {
    const f = await setup();
    const s = await signTrustStatement(
      {
        kind: "extension.takedown",
        issuedAt: "2026-10-26T12:00:00Z",
        signerKey: NIMBUS_KEY,
        extensionId: f.id,
        publisherId: "test-pub",
        versions: "*",
        reason: "x",
      },
      NIMBUS_SEED,
    );
    recordTrustStatements(f.db, [s], FEED, 1);
    expect((await readVerifiedExtensionForSpawn(f.id, deps(f))).extensionId).toBe(f.id);
  });

  test("eval: a takedown refuses although the run grant acknowledged it", async () => {
    const f = await setup({ signed: true });
    acknowledge(f, [await block(f, "extension.takedown", "malware found")]);
    // The acknowledgement is real: the spawn verifier honours it.
    expect((await readVerifiedExtensionForSpawn(f.id, deps(f))).extensionId).toBe(f.id);
    let hashed = 0;
    const treeDigest = (root: string): string => {
      hashed++;
      return computeExtensionTreeDigest(root);
    };
    await expectCode(
      readVerifiedExtensionForEval(f.id, { ...deps(f), treeDigest }),
      "ERR_EXTENSION_TAKEN_DOWN",
      /malware found/,
    );
    expect(hashed).toBe(0);
  });

  test("eval: a revoked installed key refuses although the run grant acknowledged it", async () => {
    const f = await setup({ signed: true });
    acknowledge(f, [await block(f, "key.revoke", "key leaked")]);
    expect((await readVerifiedExtensionForSpawn(f.id, deps(f))).extensionId).toBe(f.id);
    await expectCode(
      readVerifiedExtensionForEval(f.id, deps(f)),
      "ERR_EXTENSION_KEY_REVOKED",
      /key leaked/,
    );
  });

  test("eval: a revocation of the Vault key (row with no recorded fingerprint) refuses although the run grant acknowledged it", async () => {
    const f = await setup({ signed: true });
    // Not backfilled: the Vault read falls back to the legacy key, the one the revocation names.
    f.db.run("UPDATE extension SET publisher_key_fingerprint = NULL WHERE id = ?", [f.id]);
    acknowledge(f, [await block(f, "key.revoke", "vault key leaked")]);
    expect((await readVerifiedExtensionForSpawn(f.id, deps(f))).extensionId).toBe(f.id);
    await expectCode(
      readVerifiedExtensionForEval(f.id, deps(f)),
      "ERR_EXTENSION_KEY_REVOKED",
      /vault key leaked/,
    );
  });

  test("eval: a block on an extension with no run grant refuses as a typed run-grant error", async () => {
    const f = await setup({ signed: true, approve: false });
    await block(f, "extension.takedown", "malware found");
    await expectCode(readVerifiedExtensionForEval(f.id, deps(f)), "ERR_EXTENSION_TAKEN_DOWN");
  });
});

describe("readVerifiedExtensionForSpawn — a starter pack", () => {
  test("a pack with a hand-inserted run grant refuses ERR_EXTENSION_STARTER_PACK before any hash check", async () => {
    const fx = await installStarterPackFixture("nimbus-spawn-pack-");
    cleanups.push(fx.cleanup);
    const row = listExtensions(fx.db).find((r) => r.id === PACK_FIXTURE.topPack);
    expect(row?.kind).toBe("starter-pack");
    // No production path writes this: it stands for a grant that got there some other way.
    upsertRunGrant(fx.db, {
      extension_id: PACK_FIXTURE.topPack,
      service_id: "ext_fx_pack_top",
      version: "1.0.0",
      tree_digest: row?.tree_digest ?? "",
      permissions_json: serializeRunGrants({ network: [], read: [], write: [] }),
      model_access: 0,
      approved_at: 1,
      credentials_json: "{}",
    });
    await expectCode(
      readVerifiedExtensionForSpawn(PACK_FIXTURE.topPack, {
        db: fx.db,
        vault: new MockVault(),
        env: fx.env,
      }),
      "ERR_EXTENSION_STARTER_PACK",
      /^ERR_EXTENSION_STARTER_PACK: fx\.pack\.top is a starter pack: it has no code to run\./,
    );
  });
});

describe("readVerifiedExtensionForEval", () => {
  test("an installed signed extension with NO run grant verifies, and none is created", async () => {
    const f = await setup({ signed: true, approve: false });
    const v = await readVerifiedExtensionForEval(f.id, deps(f));
    expect(v).toEqual({
      extensionId: f.id,
      version: "1.0.0",
      serviceId: "ext_com_example_spawn",
      installPath: realpathSync.native(f.installPath),
      treeDigest: computeExtensionTreeDigest(f.installPath),
    });
    expect(getRunGrant(f.db, f.id)).toBeNull();
  });

  test("an approved extension verifies too, and its grant is left as it was", async () => {
    const f = await setup({ signed: true });
    const before = getRunGrant(f.db, f.id);
    expect((await readVerifiedExtensionForEval(f.id, deps(f))).extensionId).toBe(f.id);
    expect(getRunGrant(f.db, f.id)).toEqual(before);
  });

  test("an unknown id refuses NOT_FOUND", async () => {
    const f = await setup({ approve: false });
    await expectCode(
      readVerifiedExtensionForEval("com.example.nope", deps(f)),
      "ERR_EXTENSION_NOT_FOUND",
    );
  });

  test("a disabled extension refuses RUN_DISABLED", async () => {
    const f = await setup({ approve: false });
    setExtensionEnabled(f.db, f.id, false);
    await expectCode(readVerifiedExtensionForEval(f.id, deps(f)), "ERR_EXTENSION_RUN_DISABLED");
  });

  test("a starter pack refuses STARTER_PACK", async () => {
    const fx = await installStarterPackFixture("nimbus-eval-pack-");
    cleanups.push(fx.cleanup);
    await expectCode(
      readVerifiedExtensionForEval(PACK_FIXTURE.topPack, {
        db: fx.db,
        vault: new MockVault(),
        env: fx.env,
      }),
      "ERR_EXTENSION_STARTER_PACK",
    );
  });

  test("a startup signature failure refuses RUN_UNVERIFIED", async () => {
    const f = await setup({ approve: false });
    signatureDisabledRegistry.mark(f.id, "signature_failed");
    await expectCode(readVerifiedExtensionForEval(f.id, deps(f)), "ERR_EXTENSION_RUN_UNVERIFIED");
  });

  test("an entry edited after install refuses RUN_UNVERIFIED (strict hash)", async () => {
    const f = await setup({ approve: false });
    writeFileSync(join(f.installPath, "dist", "index.js"), "evil();\n");
    await expectCode(readVerifiedExtensionForEval(f.id, deps(f)), "ERR_EXTENSION_RUN_UNVERIFIED");
  });

  test("a row with no tree digest refuses RUN_NO_DIGEST", async () => {
    const f = manualInstall(
      { id: "com.example.nodigest", version: "1.0.0", entry: "dist/index.js" },
      { entryFile: (ip) => join(ip, "dist", "index.js"), noDigest: true },
    );
    await expectCode(readVerifiedExtensionForEval(f.id, deps(f)), "ERR_EXTENSION_RUN_NO_DIGEST");
  });

  test("a sibling file edited after install refuses RUN_TREE_CHANGED", async () => {
    const f = await setup({ approve: false });
    writeFileSync(join(f.installPath, "dist", "chunk.js"), "evil();\n");
    await expectCode(readVerifiedExtensionForEval(f.id, deps(f)), "ERR_EXTENSION_RUN_TREE_CHANGED");
  });

  test("a row digest that no longer matches the live tree refuses RUN_TREE_CHANGED", async () => {
    const f = await setup({ approve: false });
    setExtensionTreeDigest(f.db, f.id, "0".repeat(64));
    await expectCode(readVerifiedExtensionForEval(f.id, deps(f)), "ERR_EXTENSION_RUN_TREE_CHANGED");
  });

  test("a grant over another digest or version does not matter: only the row is compared", async () => {
    const f = await setup();
    const g = getRunGrant(f.db, f.id);
    if (g === null) throw new Error("no grant");
    upsertRunGrant(f.db, { ...g, tree_digest: "0".repeat(64), version: "0.9.0" });
    expect((await readVerifiedExtensionForEval(f.id, deps(f))).extensionId).toBe(f.id);
  });

  test("a manifest version that differs from the row refuses RUN_CHANGED", async () => {
    const f = await setup({ approve: false });
    f.db.run("UPDATE extension SET version = ? WHERE id = ?", ["0.9.0", f.id]);
    await expectCode(
      readVerifiedExtensionForEval(f.id, deps(f)),
      "ERR_EXTENSION_RUN_CHANGED",
      /1\.0\.0.*0\.9\.0/,
    );
  });

  test("a publisher key that left the Vault refuses RUN_UNVERIFIED", async () => {
    const f = await setup({ signed: true, approve: false });
    await evictPublisherKey(f.vault, "test-pub");
    await expectCode(readVerifiedExtensionForEval(f.id, deps(f)), "ERR_EXTENSION_RUN_UNVERIFIED");
  });

  test("a signature that does not verify against the Vault key refuses RUN_UNVERIFIED", async () => {
    const f = await setup({ signed: true, approve: false });
    // Not backfilled, so the Vault read returns the legacy key, which is now another key.
    f.db.run("UPDATE extension SET publisher_key_fingerprint = NULL WHERE id = ?", [f.id]);
    await f.vault.set(
      "extension.publisher_key.test-pub",
      encodeBase64(generateEd25519Keypair().pubkey),
    );
    await expectCode(
      readVerifiedExtensionForEval(f.id, deps(f)),
      "ERR_EXTENSION_RUN_UNVERIFIED",
      /signature verification/,
    );
  });

  test("an entry outside the install tree refuses ENTRY_OUTSIDE", async () => {
    const f = manualInstall(
      { id: "com.example.escape", version: "1.0.0", entry: "../outside.js" },
      { entryFile: (ip) => join(ip, "..", "outside.js") },
    );
    await expectCode(readVerifiedExtensionForEval(f.id, deps(f)), "ERR_EXTENSION_ENTRY_OUTSIDE");
  });
});
