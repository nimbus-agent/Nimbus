/**
 * Paths of `install-from-local.ts` that `install-from-local.test.ts` does not reach: the Windows
 * tar resolution on any host, archive layouts, a dependency chain read back from disk, a non-Error
 * publisher-key failure (I16's `extension.signature_failed` row), copy failures, and a source
 * manifest changed while the install was resolving its dependencies.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listExtensions } from "../automation/extension-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { registerGlobalFetchRestore, requestUrlString } from "../testing/bun-test-support.ts";
import { MockVault } from "../vault/mock.ts";
import {
  installExtensionFromLocalDirectory,
  resolveSystemTarCommand,
} from "./install-from-local.ts";
import type { FetchManifestResponse, RegistryClient } from "./registry-client.ts";
import { encodeBase64, generateEd25519Keypair, signManifest } from "./verify-signature.ts";

const tempRoots: string[] = [];
const dbs: Database[] = [];

registerGlobalFetchRestore(afterEach);

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of tempRoots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort: Windows can hold a handle briefly */
    }
  }
});

interface Fixture {
  readonly root: string;
  readonly extensionsDir: string;
  readonly db: Database;
}

function fixture(prefix: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  dbs.push(db);
  return { root, extensionsDir: join(root, "extensions"), db };
}

/** Writes an extension source directory (manifest + entry) and returns its path. */
function writeSource(parent: string, dirName: string, manifest: Record<string, unknown>): string {
  const dir = join(parent, dirName);
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "nimbus.extension.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "dist", "index.js"), "export default {};\n");
  return dir;
}

/** `tar -czf <archive> -C <cwd> <members...>` with the system tar. */
function packArchive(archive: string, cwd: string, members: readonly string[]): void {
  const r = spawnSync(resolveSystemTarCommand(), ["-czf", archive, "-C", cwd, ...members], {
    windowsHide: true,
  });
  if (r.status !== 0) throw new Error(`tar pack failed: ${String(r.stderr)}`);
}

function auditPayloads(db: Database, actionType: string): Record<string, unknown>[] {
  return db
    .query<{ action_json: string }, [string]>(
      "SELECT action_json FROM audit_log WHERE action_type = ? ORDER BY id",
    )
    .all(actionType)
    .map((r) => JSON.parse(r.action_json) as Record<string, unknown>);
}

describe("resolveSystemTarCommand — the platform branch is decidable on any host", () => {
  test("every non-Windows platform uses the tar on PATH, whatever the environment says", () => {
    expect(resolveSystemTarCommand("linux", {})).toBe("tar");
    expect(resolveSystemTarCommand("darwin", { SystemRoot: "WinRoot" })).toBe("tar");
  });

  test("Windows prefers SystemRoot, then windir", () => {
    expect(resolveSystemTarCommand("win32", { SystemRoot: "WinRoot", windir: "Other" })).toBe(
      join("WinRoot", "System32", "tar.exe"),
    );
    expect(resolveSystemTarCommand("win32", { windir: "WinDir" })).toBe(
      join("WinDir", "System32", "tar.exe"),
    );
  });

  test("Windows with no usable root falls back to the default install path", () => {
    const fallback = join("C:", "Windows", "System32", "tar.exe");
    expect(resolveSystemTarCommand("win32", {})).toBe(fallback);
    expect(resolveSystemTarCommand("win32", { SystemRoot: "" })).toBe(fallback);
  });

  test("with no arguments it reads the live process", () => {
    expect(resolveSystemTarCommand()).toBe(resolveSystemTarCommand(process.platform, process.env));
  });
});

describe("archive layouts", () => {
  test("an archive whose manifest sits at its root installs from that root", async () => {
    const f = fixture("nimbus-ifl-cov-rootarch-");
    const src = writeSource(f.root, "src", { id: "arch.root", version: "1.2.3" });
    const archive = join(f.root, "bundle.tgz");
    packArchive(archive, src, ["."]);

    const r = await installExtensionFromLocalDirectory({
      db: f.db,
      extensionsDir: f.extensionsDir,
      sourcePath: archive,
    });
    expect(r.id).toBe("arch.root");
    expect(r.version).toBe("1.2.3");
    expect(r.installPath).toBe(join(f.extensionsDir, "arch.root"));
    expect(existsSync(join(r.installPath, "dist", "index.js"))).toBe(true);
    expect(r.entryHash).toBe(createHash("sha256").update("export default {};\n").digest("hex"));
  });

  test("an archive holding only loose files is refused, naming what it looked for", async () => {
    const f = fixture("nimbus-ifl-cov-loose-");
    const stage = join(f.root, "stage");
    mkdirSync(stage);
    writeFileSync(join(stage, "README.md"), "# not an extension\n");
    const archive = join(f.root, "loose.tgz");
    packArchive(archive, stage, ["README.md"]);

    await expect(
      installExtensionFromLocalDirectory({
        db: f.db,
        extensionsDir: f.extensionsDir,
        sourcePath: archive,
      }),
    ).rejects.toThrow(
      "archive does not contain nimbus.extension.json (at root or one subdirectory deep)",
    );
    expect(existsSync(f.extensionsDir)).toBe(false);
  });
});

describe("dependency resolution reads installed manifests back from disk", () => {
  test("a chain of local installs resolves each pinned dependency's own dependsOn", async () => {
    const f = fixture("nimbus-ifl-cov-chain-");
    await installExtensionFromLocalDirectory({
      db: f.db,
      extensionsDir: f.extensionsDir,
      sourcePath: writeSource(f.root, "c", { id: "chain.c", version: "1.0.0" }),
    });
    await installExtensionFromLocalDirectory({
      db: f.db,
      extensionsDir: f.extensionsDir,
      sourcePath: writeSource(f.root, "b", {
        id: "chain.b",
        version: "1.0.0",
        dependsOn: { "chain.c": "^1.0.0" },
      }),
    });
    const r = await installExtensionFromLocalDirectory({
      db: f.db,
      extensionsDir: f.extensionsDir,
      sourcePath: writeSource(f.root, "a", {
        id: "chain.a",
        version: "1.0.0",
        dependsOn: { "chain.b": "^1.0.0" },
      }),
    });

    // `chain.c` is only reachable through `chain.b`'s INSTALLED manifest: the solver can only list
    // it if it read b's dependsOn back from disk.
    const byId = new Map(r.installed.map((n) => [n.id, n]));
    expect([...byId.keys()].sort()).toEqual(["chain.a", "chain.b", "chain.c"]);
    expect(byId.get("chain.a")?.newlyInstalled).toBe(true);
    expect(byId.get("chain.b")?.newlyInstalled).toBe(false);
    expect(byId.get("chain.c")?.newlyInstalled).toBe(false);
    expect(byId.get("chain.b")?.deps).toEqual([
      { id: "chain.c", range: "^1.0.0", resolvedVersion: "1.0.0" },
    ]);
    const [complete] = auditPayloads(f.db, "extension.install_complete").slice(-1);
    expect(complete?.["root"]).toBe("chain.a");
  });
});

describe("I16 — a publisher-key failure that is not an Error", () => {
  test("is still recorded as extension.signature_failed and refuses the install", async () => {
    const f = fixture("nimbus-ifl-cov-sigthrow-");
    const { privkey, pubkey } = generateEd25519Keypair();
    const unsigned = {
      id: "signed.thrower",
      version: "1.0.0",
      permissions: {},
      publisher: { id: "acme-pub", key: encodeBase64(pubkey) },
    };
    const signature = await signManifest(unsigned, privkey);
    const src = writeSource(f.root, "src", { ...unsigned, signature });

    const thrown: unknown = Object.freeze({ toString: () => "registry socket reset" });
    const fetcher = {
      fetch: async () => {
        throw thrown;
      },
    };
    const vault = new MockVault();

    let caught: unknown;
    try {
      await installExtensionFromLocalDirectory({
        db: f.db,
        extensionsDir: f.extensionsDir,
        sourcePath: src,
        vault,
        fetcher,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(thrown); // rethrown as-is, never swallowed
    const failed = auditPayloads(f.db, "extension.signature_failed");
    expect(failed).toEqual([
      {
        id: "signed.thrower",
        publisher_id: "acme-pub",
        error: "Unknown",
        message: "registry socket reset",
      },
    ]);
    expect(auditPayloads(f.db, "extension.signature_verified")).toEqual([]);
    expect(listExtensions(f.db)).toEqual([]);
    expect(await vault.get("extension.publisher_key.acme-pub")).toBeNull();
    // The failed install left nothing behind for the next attempt to collide with.
    expect(existsSync(join(f.extensionsDir, "signed.thrower"))).toBe(false);
  });
});

describe("copy failures are reported as such and leave nothing installed", () => {
  test("the extension itself: a file standing where its scope directory belongs", async () => {
    const f = fixture("nimbus-ifl-cov-rootcp-");
    const src = writeSource(f.root, "src", { id: "acme/widget", version: "1.0.0" });
    mkdirSync(f.extensionsDir, { recursive: true });
    writeFileSync(join(f.extensionsDir, "acme"), "a stray file, not a directory");

    await expect(
      installExtensionFromLocalDirectory({
        db: f.db,
        extensionsDir: f.extensionsDir,
        sourcePath: src,
      }),
    ).rejects.toThrow(/^extension copy failed: /);
    expect(listExtensions(f.db)).toEqual([]);
    expect(statSync(join(f.extensionsDir, "acme")).isFile()).toBe(true);
  });

  test("a registry dependency: a file standing where its install directory belongs", async () => {
    const f = fixture("nimbus-ifl-cov-depcp-");
    const depStage = join(f.root, "dep-stage");
    writeSource(depStage, "pkg", { id: "dep.blocked", version: "1.0.0" });
    const tarball = join(f.root, "dep.tgz");
    packArchive(tarball, depStage, ["pkg"]);
    const tarballBytes = new Uint8Array(readFileSync(tarball));
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = requestUrlString(input);
      if (url !== "https://registry.invalid/dep.tgz") throw new Error(`unexpected fetch ${url}`);
      return new Response(tarballBytes, { status: 200 });
    }) as typeof fetch;
    const registryClient: RegistryClient = {
      fetchPublisherKey: async () => ({ kind: "not_found" }),
      fetchLatestVersion: async (_id, channel) => ({ version: "1.0.0", channel }),
      fetchManifest: async (id, version) => ({
        manifest: {
          id,
          version,
          permissions: { network: [], filesystem: { read: [], write: [] } },
          updateChannel: "stable",
        },
        manifestRaw: { id, version },
        manifestHash: "0".repeat(64),
        entryHash: "0".repeat(64),
        tarballUrl: "https://registry.invalid/dep.tgz",
      }),
    };
    mkdirSync(f.extensionsDir, { recursive: true });
    writeFileSync(join(f.extensionsDir, "dep.blocked"), "a stray file, not a directory");
    const src = writeSource(f.root, "root", {
      id: "root.of.blocked",
      version: "1.0.0",
      dependsOn: { "dep.blocked": "^1.0.0" },
    });

    await expect(
      installExtensionFromLocalDirectory({
        db: f.db,
        extensionsDir: f.extensionsDir,
        sourcePath: src,
        registryClient,
      }),
    ).rejects.toThrow(/^dependency copy failed: /);
    // The dependency failed first, so the root was never copied either.
    expect(existsSync(join(f.extensionsDir, "root.of.blocked"))).toBe(false);
    expect(listExtensions(f.db)).toEqual([]);
  });
});

describe("a source manifest changed while dependencies were being resolved", () => {
  /**
   * Installs `toctou.dep`, then removes its on-disk manifest so the solver must ask the registry
   * for it — the one `await` between reading the root's source manifest and copying the source.
   * `onResolve` runs inside that call, standing in for a concurrent edit of the source directory.
   */
  async function installRootWhileResolving(
    prefix: string,
    onResolve: (rootSourceDir: string) => void,
  ): Promise<{
    readonly f: Fixture;
    readonly attempt: Promise<unknown>;
    readonly registryCalls: () => number;
  }> {
    const f = fixture(prefix);
    await installExtensionFromLocalDirectory({
      db: f.db,
      extensionsDir: f.extensionsDir,
      sourcePath: writeSource(f.root, "dep", { id: "toctou.dep", version: "1.0.0" }),
    });
    rmSync(join(f.extensionsDir, "toctou.dep", "nimbus.extension.json"));
    const rootSrc = writeSource(f.root, "root", {
      id: "toctou.root",
      version: "1.0.0",
      dependsOn: { "toctou.dep": "^1.0.0" },
    });
    let resolved = 0;
    const registryClient: RegistryClient = {
      fetchPublisherKey: async () => ({ kind: "not_found" }),
      fetchLatestVersion: async () => null,
      fetchManifest: async (id, version): Promise<FetchManifestResponse> => {
        resolved += 1;
        onResolve(rootSrc);
        return {
          manifest: {
            id,
            version,
            permissions: { network: [], filesystem: { read: [], write: [] } },
            updateChannel: "stable",
          },
          manifestRaw: { id, version },
          manifestHash: "0".repeat(64),
          entryHash: "0".repeat(64),
          tarballUrl: "https://registry.invalid/unused.tgz",
        };
      },
    };
    const attempt = installExtensionFromLocalDirectory({
      db: f.db,
      extensionsDir: f.extensionsDir,
      sourcePath: rootSrc,
      registryClient,
    });
    // Handled here so the rejection is never reported as unhandled before the caller awaits it.
    attempt.catch(() => undefined);
    return { f, attempt, registryCalls: () => resolved };
  }

  test("a version bump is refused rather than installed under the identity that was resolved", async () => {
    const { f, attempt, registryCalls } = await installRootWhileResolving(
      "nimbus-ifl-cov-bump-",
      (dir) => {
        writeFileSync(
          join(dir, "nimbus.extension.json"),
          JSON.stringify({ id: "toctou.root", version: "9.9.9" }),
        );
      },
    );
    await expect(attempt).rejects.toThrow("manifest id/version changed across copy");
    expect(registryCalls()).toBe(1); // the edit really did land inside resolution
    expect(existsSync(join(f.extensionsDir, "toctou.root"))).toBe(false); // rolled back
    expect(listExtensions(f.db).map((e) => e.id)).toEqual(["toctou.dep"]);
  });

  test("a deleted manifest is refused after the copy, not installed without one", async () => {
    const { f, attempt, registryCalls } = await installRootWhileResolving(
      "nimbus-ifl-cov-gone-",
      (dir) => {
        rmSync(join(dir, "nimbus.extension.json"));
      },
    );
    await expect(attempt).rejects.toThrow("extension manifest missing after copy");
    expect(registryCalls()).toBe(1);
    expect(existsSync(join(f.extensionsDir, "toctou.root"))).toBe(false);
    expect(listExtensions(f.db).map((e) => e.id)).toEqual(["toctou.dep"]);
  });
});

/**
 * A path that exists but is neither a regular file nor a directory. Probed rather than assumed by
 * platform: the test runs wherever such a path exists and verifies the premise before relying on it.
 */
function findSpecialPath(): string | undefined {
  for (const candidate of ["/dev/null"]) {
    try {
      const st = statSync(candidate);
      if (!st.isFile() && !st.isDirectory()) return candidate;
    } catch {
      /* absent on this host */
    }
  }
  return undefined;
}

const SPECIAL_PATH = findSpecialPath();

describe("a source that is neither a file nor a directory", () => {
  test.skipIf(SPECIAL_PATH === undefined)("is refused before anything is read", async () => {
    const f = fixture("nimbus-ifl-cov-special-");
    await expect(
      installExtensionFromLocalDirectory({
        db: f.db,
        extensionsDir: f.extensionsDir,
        sourcePath: SPECIAL_PATH ?? "",
      }),
    ).rejects.toThrow("extension source path must be a directory or .tar.gz archive");
    expect(existsSync(f.extensionsDir)).toBe(false);
  });
});
