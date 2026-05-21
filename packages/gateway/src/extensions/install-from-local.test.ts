import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import type { FetchManifestResponse, RegistryClient } from "./registry-client.ts";
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

describe("install-from-local — early-rejection / error-handling branches (Tier C-1)", () => {
  test("source path that does not exist throws", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "nimbus-install-noent-"));
    const extensionsDir = join(tmp, "extensions");
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    try {
      await expect(
        installExtensionFromLocalDirectory({
          db,
          extensionsDir,
          sourcePath: join(tmp, "does-not-exist"),
        }),
      ).rejects.toThrow(/source path does not exist/i);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("file source with wrong extension is rejected (not .tar.gz / .tgz)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "nimbus-install-wrongext-"));
    const extensionsDir = join(tmp, "extensions");
    const filePath = join(tmp, "not-an-archive.zip");
    writeFileSync(filePath, "not a tarball");
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    try {
      await expect(
        installExtensionFromLocalDirectory({
          db,
          extensionsDir,
          sourcePath: filePath,
        }),
      ).rejects.toThrow(/\.tar\.gz or \.tgz/i);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("directory without manifest is rejected", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "nimbus-install-no-manifest-"));
    const extensionsDir = join(tmp, "extensions");
    const src = join(tmp, "src-empty");
    mkdirSync(src, { recursive: true });
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    try {
      await expect(
        installExtensionFromLocalDirectory({
          db,
          extensionsDir,
          sourcePath: src,
        }),
      ).rejects.toThrow(/manifest not found/i);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("install fails when destination directory already exists from a previous install at a different version", async () => {
    // Install version 1.0.0 first, then try to install 2.0.0 with a fresh DB.
    // The destination directory still exists from the prior install but the
    // solver sees the root as newlyInstalled (no existing DB row), so the
    // existsSync(dest) check on line 698 fires.
    const { extensionsDir, src, db } = createExtensionInstallFixture(
      "nimbus-install-dest-exists-",
      "src-v1",
    );
    writeFileSync(
      join(src, "nimbus.extension.json"),
      JSON.stringify({ id: "dest.exists.ext", version: "1.0.0", entry: "dist/index.js" }),
      "utf8",
    );
    writeFileSync(join(src, "dist", "index.js"), "export {}\n", "utf8");
    await installExtensionFromLocalDirectory({ db, extensionsDir, sourcePath: src });

    // Fresh DB so solver sees nothing installed, but the dir still exists on disk.
    const db2 = new Database(":memory:");
    LocalIndex.ensureSchema(db2);

    const src2 = join(dirname(src), "src-v2");
    mkdirSync(join(src2, "dist"), { recursive: true });
    writeFileSync(
      join(src2, "nimbus.extension.json"),
      JSON.stringify({ id: "dest.exists.ext", version: "2.0.0", entry: "dist/index.js" }),
      "utf8",
    );
    writeFileSync(join(src2, "dist", "index.js"), "export {}\n", "utf8");

    await expect(
      installExtensionFromLocalDirectory({ db: db2, extensionsDir, sourcePath: src2 }),
    ).rejects.toThrow(/already installed at/i);
  });

  test("manifest with absolute entry path is rejected", async () => {
    const { extensionsDir, src, db } = createExtensionInstallFixture(
      "nimbus-install-absentry-",
      "src-abs",
    );
    writeFileSync(
      join(src, "nimbus.extension.json"),
      JSON.stringify({ id: "abs.entry.ext", version: "1.0.0", entry: "/etc/passwd" }),
      "utf8",
    );
    writeFileSync(join(src, "dist", "index.js"), "export {}\n", "utf8");

    await expect(
      installExtensionFromLocalDirectory({ db, extensionsDir, sourcePath: src }),
    ).rejects.toThrow(/relative path/i);

    // Rollback removed partial install.
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(extensionsDir, "abs.entry.ext"))).toBe(false);
  });

  test("manifest with entry that escapes install dir is rejected", async () => {
    const { extensionsDir, src, db } = createExtensionInstallFixture(
      "nimbus-install-escape-",
      "src-escape",
    );
    writeFileSync(
      join(src, "nimbus.extension.json"),
      JSON.stringify({ id: "escape.ext", version: "1.0.0", entry: "../../../escape.js" }),
      "utf8",
    );
    writeFileSync(join(src, "dist", "index.js"), "export {}\n", "utf8");

    await expect(
      installExtensionFromLocalDirectory({ db, extensionsDir, sourcePath: src }),
    ).rejects.toThrow(/escapes install directory/i);
  });

  test("corrupt .tgz file produces tar extraction error", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "nimbus-install-badtgz-"));
    const extensionsDir = join(tmp, "extensions");
    const badArchive = join(tmp, "bad.tgz");
    // Random non-gzip bytes — tar will refuse to extract.
    writeFileSync(badArchive, "not a real gzip archive at all");
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    try {
      await expect(
        installExtensionFromLocalDirectory({
          db,
          extensionsDir,
          sourcePath: badArchive,
        }),
      ).rejects.toThrow(/failed to extract|extract|extension manifest|not found/i);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("archive without manifest at root or one-deep is rejected", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "nimbus-install-nomf-arch-"));
    const extensionsDir = join(tmp, "extensions");
    const stage = join(tmp, "stage");
    // Two levels deep so the one-deep lookup also fails.
    mkdirSync(join(stage, "level1", "level2"), { recursive: true });
    writeFileSync(join(stage, "level1", "level2", "nimbus.extension.json"), "{}");

    const archive = join(tmp, "buried.tgz");
    const tarBin = resolveSystemTarCommand();
    const pack = spawnSync(tarBin, ["-czf", archive, "-C", stage, "level1"], {
      windowsHide: true,
    });
    expect(pack.status).toBe(0);

    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    try {
      await expect(
        installExtensionFromLocalDirectory({
          db,
          extensionsDir,
          sourcePath: archive,
        }),
      ).rejects.toThrow(/nimbus\.extension\.json|not contain/i);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("archive with manifest in subdirectory installs (one-deep fallback)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "nimbus-install-onedeep-"));
    const extensionsDir = join(tmp, "extensions");
    const stage = join(tmp, "stage");
    const pkgDir = join(stage, "pkg-inner");
    mkdirSync(join(pkgDir, "dist"), { recursive: true });
    writeFileSync(
      join(pkgDir, "nimbus.extension.json"),
      JSON.stringify({ id: "one.deep.ext", version: "1.0.0", entry: "dist/index.js" }),
    );
    writeFileSync(join(pkgDir, "dist", "index.js"), "export {}\n");

    const archive = join(tmp, "onedeep.tgz");
    const tarBin = resolveSystemTarCommand();
    const pack = spawnSync(tarBin, ["-czf", archive, "-C", stage, "pkg-inner"], {
      windowsHide: true,
    });
    expect(pack.status).toBe(0);

    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    try {
      const r = await installExtensionFromLocalDirectory({
        db,
        extensionsDir,
        sourcePath: archive,
      });
      expect(r.id).toBe("one.deep.ext");
      expect(listExtensions(db).length).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("manifest missing entry file rolls back install dir", async () => {
    const { extensionsDir, src, db } = createExtensionInstallFixture(
      "nimbus-install-missing-entry-",
      "src-missing",
    );
    writeFileSync(
      join(src, "nimbus.extension.json"),
      // entry points at a nonexistent path
      JSON.stringify({ id: "missing.entry.ext", version: "1.0.0", entry: "dist/nope.js" }),
      "utf8",
    );
    // intentionally NOT writing dist/nope.js
    await expect(
      installExtensionFromLocalDirectory({ db, extensionsDir, sourcePath: src }),
    ).rejects.toThrow(/entry file missing/i);

    const { existsSync } = await import("node:fs");
    expect(existsSync(join(extensionsDir, "missing.entry.ext"))).toBe(false);
  });
});

// ─── Tier C-2 — dependency-install path through installDepFromRegistry ────────

/**
 * Helper: build a real .tar.gz containing a single extension package. Returns
 * the tarball bytes and the entry-file SHA-256 the gateway will compute after
 * extraction. We return a closure that builds the bytes on demand so each test
 * controls the tmpdir lifecycle.
 */
function buildExtensionTarball(opts: {
  id: string;
  version: string;
  entry?: string;
  entryContents?: string;
  dependsOn?: Record<string, string>;
}): { bytes: Uint8Array; entryHash: string; manifestHash: string } {
  const stage = mkdtempSync(join(tmpdir(), "nimbus-buildtgz-"));
  try {
    const pkgDir = join(stage, "pkg");
    mkdirSync(join(pkgDir, "dist"), { recursive: true });
    const entry = opts.entry ?? "dist/index.js";
    const entryContents = opts.entryContents ?? "export default {};\n";
    const manifest: Record<string, unknown> = {
      id: opts.id,
      version: opts.version,
      entry,
    };
    if (opts.dependsOn !== undefined) {
      manifest["dependsOn"] = opts.dependsOn;
    }
    const manifestJson = JSON.stringify(manifest);
    writeFileSync(join(pkgDir, "nimbus.extension.json"), manifestJson);
    writeFileSync(join(pkgDir, entry), entryContents);

    const archive = join(stage, "out.tgz");
    const tarBin = resolveSystemTarCommand();
    const r = spawnSync(tarBin, ["-czf", archive, "-C", stage, "pkg"], {
      windowsHide: true,
    });
    if (r.status !== 0) {
      throw new Error(`tar pack failed: ${r.stderr?.toString() ?? `exit ${String(r.status)}`}`);
    }
    const bytes = new Uint8Array(readFileSync(archive));
    const entryHash = createHash("sha256").update(entryContents).digest("hex");
    const manifestHash = createHash("sha256").update(manifestJson).digest("hex");
    return { bytes, entryHash, manifestHash };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** Build a mock RegistryClient. fetchLatestVersion returns the dep version; fetchManifest returns a fixed response. */
function makeMockRegistry(opts: {
  depId: string;
  depVersion: string;
  manifestResponse?: Partial<FetchManifestResponse>;
  fetchManifestThrows?: Error;
  fetchLatestThrows?: Error;
}): RegistryClient {
  return {
    fetchPublisherKey: async () => ({ kind: "not_found" }),
    fetchLatestVersion: async (id, channel, _signal) => {
      if (opts.fetchLatestThrows) throw opts.fetchLatestThrows;
      if (id === opts.depId) {
        return { version: opts.depVersion, channel };
      }
      return null;
    },
    fetchManifest: async (id, version, _signal) => {
      if (opts.fetchManifestThrows) throw opts.fetchManifestThrows;
      if (id !== opts.depId) {
        throw new Error(`unexpected fetchManifest for ${id}`);
      }
      const base: FetchManifestResponse = {
        manifest: {
          id,
          version,
          entry: "dist/index.js",
          permissions: { network: [], filesystem: { read: [], write: [] } },
          updateChannel: "stable",
        } as FetchManifestResponse["manifest"],
        manifestRaw: { id, version },
        manifestHash: "0".repeat(64),
        entryHash: "0".repeat(64),
        tarballUrl: "https://mock.example/tarball.tgz",
      };
      return { ...base, ...opts.manifestResponse };
    },
  };
}

const originalFetch = globalThis.fetch;

describe("installDepFromRegistry — dependency install via registry (Tier C-2)", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("happy path: registry-resolved dep is fetched, extracted, installed", async () => {
    const { extensionsDir, src, db } = createExtensionInstallFixture(
      "nimbus-dep-happy-",
      "root-ext",
    );
    const depTarball = buildExtensionTarball({ id: "dep.fetched", version: "1.0.0" });

    // Stub global fetch to return the tarball bytes when downloadTarball asks.
    globalThis.fetch = (async (input: unknown) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url === "https://mock.example/tarball.tgz") {
        return new Response(depTarball.bytes, { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const registryClient = makeMockRegistry({
      depId: "dep.fetched",
      depVersion: "1.0.0",
      manifestResponse: { entryHash: depTarball.entryHash },
    });

    writeFileSync(
      join(src, "nimbus.extension.json"),
      JSON.stringify({
        id: "root.with.dep",
        version: "1.0.0",
        entry: "dist/index.js",
        dependsOn: { "dep.fetched": "^1.0.0" },
      }),
    );
    writeFileSync(join(src, "dist", "index.js"), "export {}\n");

    const r = await installExtensionFromLocalDirectory({
      db,
      extensionsDir,
      sourcePath: src,
      registryClient,
    });
    expect(r.id).toBe("root.with.dep");
    expect(r.installed.length).toBe(2);
    expect(listExtensions(db).find((e) => e.id === "dep.fetched")).toBeDefined();
    expect(listExtensions(db).find((e) => e.id === "root.with.dep")).toBeDefined();
  });

  test("entry hash mismatch rolls back dep install (row + dir removed)", async () => {
    const { extensionsDir, src, db } = createExtensionInstallFixture(
      "nimbus-dep-hashmismatch-",
      "root-mismatch",
    );
    const depTarball = buildExtensionTarball({ id: "dep.hashmiss", version: "1.0.0" });

    globalThis.fetch = (async (input: unknown) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url === "https://mock.example/tarball.tgz") {
        return new Response(depTarball.bytes, { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    // Advertise a different entry hash than what the tarball actually contains.
    const registryClient = makeMockRegistry({
      depId: "dep.hashmiss",
      depVersion: "1.0.0",
      manifestResponse: { entryHash: "f".repeat(64) },
    });

    writeFileSync(
      join(src, "nimbus.extension.json"),
      JSON.stringify({
        id: "root.hashmiss",
        version: "1.0.0",
        entry: "dist/index.js",
        dependsOn: { "dep.hashmiss": "^1.0.0" },
      }),
    );
    writeFileSync(join(src, "dist", "index.js"), "export {}\n");

    await expect(
      installExtensionFromLocalDirectory({
        db,
        extensionsDir,
        sourcePath: src,
        registryClient,
      }),
    ).rejects.toThrow(/entry hash mismatch/i);

    // Roll-back: neither root nor dep should be in the DB.
    expect(listExtensions(db).find((e) => e.id === "dep.hashmiss")).toBeUndefined();
    expect(listExtensions(db).find((e) => e.id === "root.hashmiss")).toBeUndefined();
    // Dep directory rolled back from disk.
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(extensionsDir, "dep.hashmiss"))).toBe(false);
  });

  test("fetchManifest failure during install (second call) produces 'could not fetch manifest' error", async () => {
    const { extensionsDir, src, db } = createExtensionInstallFixture(
      "nimbus-dep-fetchfail-",
      "root-fetchfail",
    );

    // The solver calls registryClient.fetchManifest once during planning to learn
    // the dep's own transitive deps. Then installDepFromRegistry calls
    // fetchManifest a SECOND time to learn the tarball URL. Fail only on the
    // second call to drive the catch block at lines 438-443.
    let callCount = 0;
    const registryClient: RegistryClient = {
      fetchPublisherKey: async () => ({ kind: "not_found" }),
      fetchLatestVersion: async (_id, channel) => ({ version: "1.0.0", channel }),
      fetchManifest: async (id, version) => {
        callCount++;
        if (callCount === 1) {
          // Solver-time manifest fetch: succeed.
          return {
            manifest: { id, version, entry: "dist/index.js" } as FetchManifestResponse["manifest"],
            manifestRaw: { id, version },
            manifestHash: "0".repeat(64),
            entryHash: "0".repeat(64),
            tarballUrl: "https://mock.example/tarball.tgz",
          };
        }
        // Install-time manifest fetch: fail.
        throw new Error("network down");
      },
    };

    writeFileSync(
      join(src, "nimbus.extension.json"),
      JSON.stringify({
        id: "root.fetchfail",
        version: "1.0.0",
        entry: "dist/index.js",
        dependsOn: { "dep.fetchfail": "^1.0.0" },
      }),
    );
    writeFileSync(join(src, "dist", "index.js"), "export {}\n");

    await expect(
      installExtensionFromLocalDirectory({
        db,
        extensionsDir,
        sourcePath: src,
        registryClient,
      }),
    ).rejects.toThrow(/could not fetch manifest|network down/i);
  });

  test("tarball download failure produces 'could not download tarball' error", async () => {
    const { extensionsDir, src, db } = createExtensionInstallFixture(
      "nimbus-dep-dlfail-",
      "root-dlfail",
    );

    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    const registryClient = makeMockRegistry({
      depId: "dep.dlfail",
      depVersion: "1.0.0",
    });

    writeFileSync(
      join(src, "nimbus.extension.json"),
      JSON.stringify({
        id: "root.dlfail",
        version: "1.0.0",
        entry: "dist/index.js",
        dependsOn: { "dep.dlfail": "^1.0.0" },
      }),
    );
    writeFileSync(join(src, "dist", "index.js"), "export {}\n");

    await expect(
      installExtensionFromLocalDirectory({
        db,
        extensionsDir,
        sourcePath: src,
        registryClient,
      }),
    ).rejects.toThrow(/could not download tarball|connection refused/i);
  });

  test("dep id mismatch in extracted manifest is rejected", async () => {
    const { extensionsDir, src, db } = createExtensionInstallFixture(
      "nimbus-dep-idmismatch-",
      "root-idmismatch",
    );
    // Tarball has id "different.id" but registry says "dep.expected".
    const depTarball = buildExtensionTarball({ id: "different.id", version: "1.0.0" });

    globalThis.fetch = (async (input: unknown) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url === "https://mock.example/tarball.tgz") {
        return new Response(depTarball.bytes, { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const registryClient = makeMockRegistry({
      depId: "dep.expected",
      depVersion: "1.0.0",
      manifestResponse: { entryHash: depTarball.entryHash },
    });

    writeFileSync(
      join(src, "nimbus.extension.json"),
      JSON.stringify({
        id: "root.idmismatch",
        version: "1.0.0",
        entry: "dist/index.js",
        dependsOn: { "dep.expected": "^1.0.0" },
      }),
    );
    writeFileSync(join(src, "dist", "index.js"), "export {}\n");

    await expect(
      installExtensionFromLocalDirectory({
        db,
        extensionsDir,
        sourcePath: src,
        registryClient,
      }),
    ).rejects.toThrow(/id mismatch|advertised/i);
  });

  test("dep version mismatch in extracted manifest is rejected", async () => {
    const { extensionsDir, src, db } = createExtensionInstallFixture(
      "nimbus-dep-vermismatch-",
      "root-vermismatch",
    );
    // Tarball has version 9.9.9 but registry advertised 1.0.0.
    const depTarball = buildExtensionTarball({ id: "dep.ver", version: "9.9.9" });

    globalThis.fetch = (async (input: unknown) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url === "https://mock.example/tarball.tgz") {
        return new Response(depTarball.bytes, { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    // We need the solver to ask for 1.0.0, so listVersions must return 1.0.0
    // and the manifest fetch must succeed with version 1.0.0 in the metadata.
    const registryClient: RegistryClient = {
      fetchPublisherKey: async () => ({ kind: "not_found" }),
      fetchLatestVersion: async (_id, channel, _signal) => ({ version: "1.0.0", channel }),
      fetchManifest: async (id, version, _signal) => ({
        manifest: { id, version, entry: "dist/index.js" } as FetchManifestResponse["manifest"],
        manifestRaw: { id, version },
        manifestHash: "0".repeat(64),
        entryHash: depTarball.entryHash,
        tarballUrl: "https://mock.example/tarball.tgz",
      }),
    };

    writeFileSync(
      join(src, "nimbus.extension.json"),
      JSON.stringify({
        id: "root.vermismatch",
        version: "1.0.0",
        entry: "dist/index.js",
        dependsOn: { "dep.ver": "^1.0.0" },
      }),
    );
    writeFileSync(join(src, "dist", "index.js"), "export {}\n");

    await expect(
      installExtensionFromLocalDirectory({
        db,
        extensionsDir,
        sourcePath: src,
        registryClient,
      }),
    ).rejects.toThrow(/version mismatch/i);
  });

  test("root with dep but no registryClient errors out before any disk mutation", async () => {
    // The solver tries to listVersions for the missing dep; with no registry
    // and dep not installed, the solver should refuse (OfflineDependencyResolutionError-class).
    const { extensionsDir, src, db } = createExtensionInstallFixture(
      "nimbus-dep-noregistry-",
      "root-noreg",
    );
    writeFileSync(
      join(src, "nimbus.extension.json"),
      JSON.stringify({
        id: "root.noreg",
        version: "1.0.0",
        entry: "dist/index.js",
        dependsOn: { "dep.uninstalled": "^1.0.0" },
      }),
    );
    writeFileSync(join(src, "dist", "index.js"), "export {}\n");

    await expect(
      installExtensionFromLocalDirectory({ db, extensionsDir, sourcePath: src }),
    ).rejects.toThrow();

    // No disk mutation.
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(extensionsDir, "root.noreg"))).toBe(false);
    expect(listExtensions(db).find((e) => e.id === "root.noreg")).toBeUndefined();
  });

  test("solverFetcher.fetchManifest reads installed dep from disk (pinned version path)", async () => {
    // Pre-install dep A at 1.0.0 via the normal flow.
    const {
      extensionsDir,
      src: srcA,
      db,
    } = createExtensionInstallFixture("nimbus-dep-fromdisk-", "ext-a-disk");
    writeFileSync(
      join(srcA, "nimbus.extension.json"),
      JSON.stringify({ id: "disk.dep.a", version: "1.0.0", entry: "dist/index.js" }),
    );
    writeFileSync(join(srcA, "dist", "index.js"), "export {}\n");
    await installExtensionFromLocalDirectory({ db, extensionsDir, sourcePath: srcA });

    // Install root B requiring A — the solverFetcher.fetchManifest with the
    // pinned version should hit the disk-read branch (lines 660-670).
    const tmp = mkdtempSync(join(tmpdir(), "nimbus-fromdisk-root-"));
    try {
      const srcB = join(tmp, "ext-b-disk");
      mkdirSync(join(srcB, "dist"), { recursive: true });
      writeFileSync(
        join(srcB, "nimbus.extension.json"),
        JSON.stringify({
          id: "disk.root.b",
          version: "1.0.0",
          entry: "dist/index.js",
          dependsOn: { "disk.dep.a": "^1.0.0" },
        }),
      );
      writeFileSync(join(srcB, "dist", "index.js"), "export {}\n");

      const r = await installExtensionFromLocalDirectory({
        db,
        extensionsDir,
        sourcePath: srcB,
      });
      expect(r.id).toBe("disk.root.b");
      // Dep A was already installed (newlyInstalled=false in the closure).
      const depNode = r.installed.find((n) => n.id === "disk.dep.a");
      expect(depNode?.newlyInstalled).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
