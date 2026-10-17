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
  insertExtensionRow,
  setExtensionEnabled,
  setExtensionTreeDigest,
} from "../automation/extension-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { MockVault } from "../vault/mock.ts";
import { approveExtensionRun } from "./approve-run.ts";
import { type ExtensionRunGrantEnv, serializeRunGrants } from "./extension-run-grants.ts";
import { signatureDisabledRegistry } from "./hard-disable.ts";
import { installExtensionFromLocalDirectory } from "./install-from-local.ts";
import { evictPublisherKey } from "./publisher-keys.ts";
import { ExtensionRunGrantError, type ExtensionRunGrantErrorCode } from "./run-grant-error.ts";
import { getRunGrant, upsertRunGrant } from "./run-grant-store.ts";
import { computeExtensionTreeDigest } from "./tree-digest.ts";
import { readVerifiedExtensionForSpawn } from "./verified-extension.ts";
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
          fetcher: { fetch: async () => ({ kind: "not_found" as const }) },
          enforceAirGap: false,
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
  });
  return { db, root, installPath, env, vault: new MockVault(), id };
}

async function expectCode(p: Promise<unknown>, code: ExtensionRunGrantErrorCode): Promise<void> {
  let caught: unknown;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(ExtensionRunGrantError);
  expect((caught as ExtensionRunGrantError).code).toBe(code);
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
    await f.vault.set(
      "extension.publisher_key.test-pub",
      encodeBase64(generateEd25519Keypair().pubkey),
    );
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

  test("7c: a UNC entry refuses ENTRY_OUTSIDE (win32 path rules, injected)", async () => {
    const entry = String.raw`\\server\share\x.js`;
    const f = manualInstall(
      { id: "com.example.unc", version: "1.0.0", entry },
      { entryFile: (ip) => join(ip, entry) },
    );
    await expectCode(
      readVerifiedExtensionForSpawn(f.id, { ...deps(f), env: { ...f.env, platform: "win32" } }),
      "ERR_EXTENSION_ENTRY_OUTSIDE",
    );
  });

  // A drive-letter name cannot exist as a FILE on a Windows host (the colon), so this is a
  // POSIX-host test of the win32 path rules; on Windows the same manifest cannot pass step 3.
  test.skipIf(process.platform === "win32")(
    "7d: a drive-letter entry refuses ENTRY_OUTSIDE (win32 path rules, injected)",
    async () => {
      const entry = String.raw`C:\x.js`;
      const f = manualInstall(
        { id: "com.example.drive", version: "1.0.0", entry },
        { entryFile: (ip) => join(ip, entry) },
      );
      await expectCode(
        readVerifiedExtensionForSpawn(f.id, { ...deps(f), env: { ...f.env, platform: "win32" } }),
        "ERR_EXTENSION_ENTRY_OUTSIDE",
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
