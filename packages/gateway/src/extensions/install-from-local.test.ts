import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { listExtensions } from "../automation/extension-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { MockVault } from "../vault/mock.ts";
import {
  assertSafeExtensionId,
  extensionInstallDirectory,
  installExtensionFromLocalDirectory,
  resolveSystemTarCommand,
} from "./install-from-local.ts";
import { readPublisherKey } from "./publisher-keys.ts";
import {
  encodeBase64,
  generateEd25519Keypair,
  PublisherKeyMismatch,
  SignatureInvalid,
  signManifest,
} from "./verify-signature.ts";

function createExtensionInstallFixture(
  tmpPrefix: string,
  sourceBasename: string,
): {
  extensionsDir: string;
  src: string;
  db: Database;
} {
  const tmp = mkdtempSync(join(tmpdir(), tmpPrefix));
  const extensionsDir = join(tmp, "extensions");
  const src = join(tmp, sourceBasename);
  mkdirSync(join(src, "dist"), { recursive: true });
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return { extensionsDir, src, db };
}

describe("install-from-local", () => {
  test("assertSafeExtensionId rejects path traversal", () => {
    expect(() => assertSafeExtensionId("../evil")).toThrow();
    expect(() => assertSafeExtensionId("a/../b")).toThrow();
    expect(() => assertSafeExtensionId("@scope/pkg")).not.toThrow();
  });

  // S7-F9
  test("assertSafeExtensionId rejects ids longer than 128 characters", () => {
    expect(() => assertSafeExtensionId("a".repeat(128))).not.toThrow();
    expect(() => assertSafeExtensionId("a".repeat(129))).toThrow(/too long/i);
    expect(() => assertSafeExtensionId(`@scope/${"a".repeat(200)}`)).toThrow(/too long/i);
  });

  test("extensionInstallDirectory joins scoped id safely", () => {
    const root = join(tmpdir(), "nimbus-ext-test");
    expect(extensionInstallDirectory(root, "@acme/demo")).toBe(join(root, "@acme", "demo"));
  });

  test("installExtensionFromLocalDirectory copies, hashes, and inserts row", async () => {
    const { extensionsDir, src, db } = createExtensionInstallFixture(
      "nimbus-install-ext-",
      "src-ext",
    );
    writeFileSync(
      join(src, "nimbus.extension.json"),
      JSON.stringify({
        id: "test.ext.sample",
        version: "1.0.0",
        entry: "dist/index.js",
      }),
      "utf8",
    );
    writeFileSync(join(src, "dist", "index.js"), "export {}\n", "utf8");

    const r = await installExtensionFromLocalDirectory({
      db,
      extensionsDir,
      sourcePath: src,
    });
    expect(r.id).toBe("test.ext.sample");
    expect(r.version).toBe("1.0.0");
    expect(
      readFileSync(join(extensionsDir, "test.ext.sample", "dist", "index.js"), "utf8"),
    ).toContain("export {}");

    const rows = listExtensions(db);
    expect(rows.length).toBe(1);
    expect(rows[0]?.id).toBe("test.ext.sample");
    expect(rows[0]?.install_path).toBe(join(extensionsDir, "test.ext.sample"));
    expect(rows[0]?.manifest_hash.length).toBe(64);
    expect(rows[0]?.entry_hash.length).toBe(64);
  });

  test("legacy nimbus-extension.json is accepted", async () => {
    const { extensionsDir, src, db } = createExtensionInstallFixture(
      "nimbus-install-legacy-",
      "src",
    );
    writeFileSync(
      join(src, "nimbus-extension.json"),
      JSON.stringify({ id: "legacy.pkg", version: "0.1.0", entry: "dist/index.js" }),
      "utf8",
    );
    writeFileSync(join(src, "dist", "index.js"), "1\n", "utf8");

    await installExtensionFromLocalDirectory({ db, extensionsDir, sourcePath: src });
    expect(listExtensions(db).length).toBe(1);
  });

  test("installExtensionFromLocalDirectory accepts .tar.gz bundle", async () => {
    const { extensionsDir, src, db } = createExtensionInstallFixture(
      "nimbus-install-tgz-",
      "pkg-root",
    );
    writeFileSync(
      join(src, "nimbus.extension.json"),
      JSON.stringify({ id: "bundle.tar.ext", version: "1.0.0", entry: "dist/index.js" }),
      "utf8",
    );
    writeFileSync(join(src, "dist", "index.js"), "export {}\n", "utf8");
    // Write the archive outside the tree being packed — creating a .tgz next to the
    // source folder can make Windows tar exit non-zero while the archive grows in the same directory.
    const archive = join(tmpdir(), `nimbus-ext-test-${process.pid}-${Date.now()}.tgz`);
    const tarBin = resolveSystemTarCommand();
    try {
      const pack = spawnSync(tarBin, ["-czf", archive, "-C", dirname(src), basename(src)], {
        windowsHide: true,
      });
      expect(pack.status).toBe(0);

      const r = await installExtensionFromLocalDirectory({
        db,
        extensionsDir,
        sourcePath: archive,
      });
      expect(r.id).toBe("bundle.tar.ext");
      expect(listExtensions(db).length).toBe(1);
    } finally {
      try {
        rmSync(archive, { force: true });
      } catch {
        /* ignore */
      }
    }
  });
});

describe("install-from-local symlink + traversal hardening (G7)", () => {
  test("rejects extension source that contains a symlink (S7-F5)", async () => {
    if (process.platform === "win32") {
      // Symlink creation requires elevated privileges on Windows; skip.
      return;
    }
    const { symlinkSync, unlinkSync } = await import("node:fs");
    const { extensionsDir, src, db } = createExtensionInstallFixture(
      "nimbus-symlink-",
      "src-symlink",
    );
    writeFileSync(
      join(src, "nimbus.extension.json"),
      JSON.stringify({ id: "ext.symlink", version: "1.0.0", entry: "dist/index.js" }),
      "utf8",
    );
    writeFileSync(join(src, "dist", "index.js"), "/* legit */\n", "utf8");

    // Replace dist/index.js with a symlink to a system file.
    const sym = join(src, "dist", "index.js");
    unlinkSync(sym);
    symlinkSync("/etc/hostname", sym);

    await expect(
      installExtensionFromLocalDirectory({ db, extensionsDir, sourcePath: src }),
    ).rejects.toThrow(/symlink/i);
  });
});

async function writeSignedSource(opts: {
  sourceDir: string;
  id: string;
  privkey: Uint8Array;
  pubkey: Uint8Array;
  publisherId?: string;
}): Promise<void> {
  mkdirSync(join(opts.sourceDir, "dist"), { recursive: true });
  const manifest = {
    id: opts.id,
    version: "1.0.0",
    permissions: {},
    publisher: { id: opts.publisherId ?? "test-pub", key: encodeBase64(opts.pubkey) },
  };
  const signature = await signManifest(manifest, opts.privkey);
  writeFileSync(
    join(opts.sourceDir, "nimbus.extension.json"),
    JSON.stringify({ ...manifest, signature }),
  );
  writeFileSync(join(opts.sourceDir, "dist", "index.js"), "export default {};");
}

describe("installExtensionFromLocalDirectory — signed extensions (I16)", () => {
  test("rejects when publisher.key in manifest disagrees with --publisher-key file", async () => {
    const { extensionsDir, src, db } = createExtensionInstallFixture(
      "nimbus-install-sig-mismatch-",
      "src",
    );
    const vault = new MockVault();
    const signer = generateEd25519Keypair();
    const otherKey = generateEd25519Keypair().pubkey;
    await writeSignedSource({
      sourceDir: src,
      id: "test-ext-mismatch",
      privkey: signer.privkey,
      pubkey: signer.pubkey,
    });
    const keyDir = mkdtempSync(join(tmpdir(), "nimbus-pub-"));
    const keyFile = join(keyDir, "pub.key");
    writeFileSync(keyFile, `${encodeBase64(otherKey)}\n`);
    try {
      await expect(
        installExtensionFromLocalDirectory({
          db,
          extensionsDir,
          sourcePath: src,
          vault,
          fetcher: { fetch: async () => ({ kind: "not_found" }) },
          enforceAirGap: false,
          publisherKeyPath: keyFile,
        }),
      ).rejects.toThrow(PublisherKeyMismatch);
    } finally {
      rmSync(keyDir, { recursive: true, force: true });
    }
  });

  test("installs successfully when --publisher-key matches manifest publisher.key", async () => {
    const { extensionsDir, src, db } = createExtensionInstallFixture(
      "nimbus-install-sig-ok-",
      "src",
    );
    const vault = new MockVault();
    const { privkey, pubkey } = generateEd25519Keypair();
    await writeSignedSource({ sourceDir: src, id: "test-ext-ok", privkey, pubkey });
    const keyDir = mkdtempSync(join(tmpdir(), "nimbus-pub-"));
    const keyFile = join(keyDir, "pub.key");
    writeFileSync(keyFile, `${encodeBase64(pubkey)}\n`);
    try {
      const result = await installExtensionFromLocalDirectory({
        db,
        extensionsDir,
        sourcePath: src,
        vault,
        fetcher: { fetch: async () => ({ kind: "not_found" }) },
        enforceAirGap: false,
        publisherKeyPath: keyFile,
      });
      expect(result.id).toBe("test-ext-ok");
      expect(await readPublisherKey(vault, "test-pub")).toEqual(pubkey);
    } finally {
      rmSync(keyDir, { recursive: true, force: true });
    }
  });

  test("refuses install when manifest tampered after signing", async () => {
    const { extensionsDir, src, db } = createExtensionInstallFixture(
      "nimbus-install-sig-tampered-",
      "src",
    );
    const vault = new MockVault();
    const { privkey, pubkey } = generateEd25519Keypair();
    await writeSignedSource({
      sourceDir: src,
      id: "test-ext-tampered",
      privkey,
      pubkey,
    });
    const mfPath = join(src, "nimbus.extension.json");
    const parsed = JSON.parse(readFileSync(mfPath, "utf8")) as Record<string, unknown>;
    parsed["version"] = "9.9.9";
    writeFileSync(mfPath, JSON.stringify(parsed));
    await expect(
      installExtensionFromLocalDirectory({
        db,
        extensionsDir,
        sourcePath: src,
        vault,
        fetcher: { fetch: async () => ({ kind: "ok", pubkey }) },
        enforceAirGap: false,
      }),
    ).rejects.toThrow(SignatureInvalid);
  });

  test("unsigned manifest installs without writing publisher_key vault entry", async () => {
    const { extensionsDir, src, db } = createExtensionInstallFixture(
      "nimbus-install-unsigned-",
      "src",
    );
    const vault = new MockVault();
    writeFileSync(
      join(src, "nimbus.extension.json"),
      JSON.stringify({ id: "test-ext-unsigned", version: "1.0.0", permissions: {} }),
    );
    writeFileSync(join(src, "dist", "index.js"), "export default {};");
    const result = await installExtensionFromLocalDirectory({
      db,
      extensionsDir,
      sourcePath: src,
      vault,
      fetcher: { fetch: async () => ({ kind: "not_found" }) },
      enforceAirGap: false,
    });
    expect(result.id).toBe("test-ext-unsigned");
    expect(await readPublisherKey(vault, "test-pub")).toBeUndefined();
  });
});

describe("installExtensionFromLocalDirectory — dependency resolution (T2 PR 4)", () => {
  test("installs closure leaf-first: already-installed dep is skipped, root is newly installed", async () => {
    // Pre-install dep A so the solver sees it as already installed.
    const {
      extensionsDir,
      src: srcA,
      db,
    } = createExtensionInstallFixture("nimbus-closure-dep-", "ext-a");
    writeFileSync(
      join(srcA, "nimbus.extension.json"),
      JSON.stringify({ id: "closure.dep.a", version: "1.0.0", entry: "dist/index.js" }),
      "utf8",
    );
    writeFileSync(join(srcA, "dist", "index.js"), "export {}\n", "utf8");
    await installExtensionFromLocalDirectory({ db, extensionsDir, sourcePath: srcA });

    // Now install root B which depends on A@^1.0.0.
    const tmp = mkdtempSync(join(tmpdir(), "nimbus-closure-root-"));
    const srcB = join(tmp, "ext-b");
    mkdirSync(join(srcB, "dist"), { recursive: true });
    writeFileSync(
      join(srcB, "nimbus.extension.json"),
      JSON.stringify({
        id: "closure.root.b",
        version: "1.0.0",
        entry: "dist/index.js",
        dependsOn: { "closure.dep.a": "^1.0.0" },
      }),
      "utf8",
    );
    writeFileSync(join(srcB, "dist", "index.js"), "export {}\n", "utf8");

    const result = await installExtensionFromLocalDirectory({
      db,
      extensionsDir,
      sourcePath: srcB,
    });

    // Root was installed.
    expect(result.id).toBe("closure.root.b");
    expect(result.version).toBe("1.0.0");

    // The `installed` array contains both the dep and the root (leaf-first order).
    expect(result.installed.length).toBe(2);

    const depNode = result.installed.find((n) => n.id === "closure.dep.a");
    const rootNode = result.installed.find((n) => n.id === "closure.root.b");
    expect(depNode).toBeDefined();
    expect(rootNode).toBeDefined();
    // A was already installed — should not be marked as newly installed.
    expect(depNode?.newlyInstalled).toBe(false);
    // B is newly installed.
    expect(rootNode?.newlyInstalled).toBe(true);

    // Root B's dep edge was recorded.
    expect(rootNode?.deps.length).toBe(1);
    expect(rootNode?.deps[0]?.id).toBe("closure.dep.a");

    // Dep node appears before root in the leaf-first ordering.
    const depIdx = result.installed.findIndex((n) => n.id === "closure.dep.a");
    const rootIdx = result.installed.findIndex((n) => n.id === "closure.root.b");
    expect(depIdx).toBeLessThan(rootIdx);

    rmSync(tmp, { recursive: true, force: true });
  });

  test("refuses install on conflict; zero disk mutation", async () => {
    // Pre-install dep A at version 1.5.0.
    const {
      extensionsDir,
      src: srcA,
      db,
    } = createExtensionInstallFixture("nimbus-conflict-dep-", "ext-a-conflict");
    writeFileSync(
      join(srcA, "nimbus.extension.json"),
      JSON.stringify({ id: "conflict.dep.a", version: "1.5.0", entry: "dist/index.js" }),
      "utf8",
    );
    writeFileSync(join(srcA, "dist", "index.js"), "export {}\n", "utf8");
    await installExtensionFromLocalDirectory({ db, extensionsDir, sourcePath: srcA });

    // Root B requires A@^2.0.0 — conflicts with the installed 1.5.0.
    const tmp = mkdtempSync(join(tmpdir(), "nimbus-conflict-root-"));
    const srcB = join(tmp, "ext-b-conflict");
    mkdirSync(join(srcB, "dist"), { recursive: true });
    writeFileSync(
      join(srcB, "nimbus.extension.json"),
      JSON.stringify({
        id: "conflict.root.b",
        version: "1.0.0",
        entry: "dist/index.js",
        dependsOn: { "conflict.dep.a": "^2.0.0" },
      }),
      "utf8",
    );
    writeFileSync(join(srcB, "dist", "index.js"), "export {}\n", "utf8");

    try {
      // Solver must throw DependencyConflictError (1.5.0 does not satisfy ^2.0.0).
      await expect(
        installExtensionFromLocalDirectory({ db, extensionsDir, sourcePath: srcB }),
      ).rejects.toThrow(/dependency_conflict/i);

      // Root B must NOT have been written to disk (error before any disk mutation).
      const { existsSync } = await import("node:fs");
      expect(existsSync(join(extensionsDir, "conflict.root.b"))).toBe(false);

      // Only the pre-installed A is in the DB (root B was not inserted).
      const rows = listExtensions(db);
      expect(rows.every((r) => r.id !== "conflict.root.b")).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("rolls back newly-created directories on failure mid-install", async () => {
    // Root with a missing entry file — completeExtensionInstallAfterCopy will throw
    // "extension entry file missing" after cpSync. The rollback should remove the dest dir.
    const { extensionsDir, src, db } = createExtensionInstallFixture(
      "nimbus-rollback-",
      "ext-rollback",
    );
    // Write manifest pointing to an entry that does NOT exist.
    writeFileSync(
      join(src, "nimbus.extension.json"),
      JSON.stringify({ id: "rollback.root", version: "1.0.0", entry: "dist/missing.js" }),
      "utf8",
    );
    // Note: intentionally NOT writing dist/missing.js

    await expect(
      installExtensionFromLocalDirectory({ db, extensionsDir, sourcePath: src }),
    ).rejects.toThrow(/entry file missing/i);

    // The rollback must have removed the partially-installed directory.
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(extensionsDir, "rollback.root"))).toBe(false);

    // Nothing was inserted into the DB.
    expect(listExtensions(db).length).toBe(0);
  });
});
