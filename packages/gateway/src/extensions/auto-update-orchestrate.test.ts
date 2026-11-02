import { describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as tar from "tar";

import { rmDirWithRetry } from "../../test/helpers/rm-dir-with-retry.ts";
import { createPerformDowngrade, createPerformUpgrade } from "./auto-update-orchestrate.ts";
import type { AvailableUpdate, UpdatePlan } from "./auto-update-types.ts";
import { sourceKey } from "./dependency-types.ts";
import { extractPackage as realExtractPackage } from "./package-extract.ts";
import type { RegistryDependencyResolver } from "./registry/registry-dependency-fetcher.ts";
import { pendingDir as pendingVersionDir, prevVersionDir } from "./version-store.ts";

const sha = (s: string): string =>
  createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

const MANIFEST_V11 = JSON.stringify({ id: "com.example.a", version: "1.1.0" });
const MANIFEST_V10 = JSON.stringify({ id: "com.example.a", version: "1.0.0" });

/** Writes a minimal real package (manifest + default entry) so the measured hashes are known. */
async function writePackage(dir: string, manifestText: string, entryText: string): Promise<void> {
  await mkdir(join(dir, "dist"), { recursive: true });
  await writeFile(join(dir, "nimbus.extension.json"), manifestText);
  await writeFile(join(dir, "dist", "index.js"), entryText);
}

function mkAvailable(overrides: Partial<AvailableUpdate> = {}): AvailableUpdate {
  return {
    id: "com.example.a",
    displayName: "A",
    fromVersion: "1.0.0",
    toVersion: "1.1.0",
    channel: "stable",
    changelog: "",
    publisherStatus: "verified",
    manifestHash: sha(MANIFEST_V11),
    signatureB64: `${"B".repeat(86)}==`,
    entryHash: sha("entry-v1.1"),
    packageSha256: "f".repeat(64),
    packageSizeBytes: 100,
    sourceRegistry: "main",
    rootFingerprint: "c".repeat(32),
    packagePath: "extensions/com.example.a/1.1.0/package.tgz",
    permissionDiff: {
      network: { added: [], removed: [] },
      filesystem: {
        read: { added: [], removed: [] },
        write: { added: [], removed: [] },
      },
    },
    verificationStatus: "verified",
    detectedAt: 0,
    ...overrides,
  };
}

describe("createPerformUpgrade", () => {
  it("downloads, verifies, swaps, invalidates mesh, updates extension row", async () => {
    const root = await mkdtemp(join(tmpdir(), "nimbus-orchestrate-"));
    try {
      const extRoot = join(root, "extensions", "com.example.a");
      await mkdir(extRoot, { recursive: true });
      await writeFile(join(extRoot, "marker.txt"), "old");

      const tarballBytes = new TextEncoder().encode("fake-tarball-bytes");
      const stopExtensionClient = mock(async (_id: string) => {});
      const dbUpdateExtensionRow = mock(
        async (
          _id: string,
          _version: string,
          _manifestHash: string,
          _entryHash: string,
          _treeDigest: string,
        ) => {},
      );
      const extractPackage = mock(async (_archive: string, destDir: string) => {
        await writePackage(destDir, MANIFEST_V11, "entry-v1.1");
        await writeFile(join(destDir, "marker.txt"), "new");
        return { sourceRoot: destDir, treeDigest: "d".repeat(64) };
      });

      const perform = createPerformUpgrade({
        extensionsRoot: join(root, "extensions"),
        reverifyManifest: async () => {},
        fetchPackage: async () => tarballBytes,
        signal: new AbortController().signal,
        sha256OfPackage: async (b) => {
          expect(b).toEqual(tarballBytes);
          return "f".repeat(64);
        },
        extractPackage,
        stopExtensionClient,
        dbUpdateExtensionRow,
      });

      await perform(mkAvailable());

      expect(await readFile(join(extRoot, "marker.txt"), "utf8")).toBe("new");
      expect(stopExtensionClient).toHaveBeenCalledWith("com.example.a");
      // The row gets the ENTRY FILE's hash — what startup verification re-measures — never the
      // tarball's.
      expect(dbUpdateExtensionRow).toHaveBeenCalledWith(
        "com.example.a",
        "1.1.0",
        sha(MANIFEST_V11),
        sha("entry-v1.1"),
        "d".repeat(64),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("checks the PACKAGE against packageSha256, not entryHash", async () => {
    const root = await mkdtemp(join(tmpdir(), "nimbus-orchestrate-"));
    try {
      await mkdir(join(root, "extensions", "com.example.a"), { recursive: true });
      const extractPackage = mock(async () => ({ sourceRoot: "", treeDigest: "" }));
      const perform = createPerformUpgrade({
        extensionsRoot: join(root, "extensions"),
        reverifyManifest: async () => {},
        fetchPackage: async () => new Uint8Array([1, 2, 3]),
        signal: new AbortController().signal,
        // Equal to entryHash: the old check accepted this tarball; the fixed one must not.
        sha256OfPackage: async () => sha("entry-v1.1"),
        extractPackage,
        stopExtensionClient: async () => {},
        dbUpdateExtensionRow: async () => {},
      });
      await expect(perform(mkAvailable())).rejects.toThrow(/sha256_mismatch/);
      expect(extractPackage).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a tarball whose extracted entry differs from entryHash, before the swap", async () => {
    const root = await mkdtemp(join(tmpdir(), "nimbus-orchestrate-"));
    let pendingDir: string | undefined;
    try {
      const extRoot = join(root, "extensions", "com.example.a");
      await mkdir(extRoot, { recursive: true });
      await writeFile(join(extRoot, "marker.txt"), "old");
      const stopExtensionClient = mock(async () => {});
      const dbUpdateExtensionRow = mock(async () => {});
      const perform = createPerformUpgrade({
        extensionsRoot: join(root, "extensions"),
        reverifyManifest: async () => {},
        fetchPackage: async () => new Uint8Array([1, 2, 3]),
        signal: new AbortController().signal,
        sha256OfPackage: async () => "f".repeat(64),
        extractPackage: async (_archive, destDir) => {
          pendingDir = destDir;
          await writePackage(destDir, MANIFEST_V11, "tampered-entry");
          return { sourceRoot: destDir, treeDigest: "d".repeat(64) };
        },
        stopExtensionClient,
        dbUpdateExtensionRow,
      });

      await expect(perform(mkAvailable())).rejects.toThrow(/package_hash_mismatch: entry/);
      expect(await readFile(join(extRoot, "marker.txt"), "utf8")).toBe("old");
      expect(dbUpdateExtensionRow).not.toHaveBeenCalled();
      expect(stopExtensionClient).not.toHaveBeenCalled();
      expect(pendingDir).toBeDefined();
      const { stat: fsStat } = await import("node:fs/promises");
      await expect(fsStat(pendingDir ?? "")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("apply refuses a package whose sha differs (sha256_mismatch, before any disk mutation)", async () => {
    const root = await mkdtemp(join(tmpdir(), "nimbus-orchestrate-"));
    try {
      const extRoot = join(root, "extensions", "com.example.a");
      await mkdir(extRoot, { recursive: true });
      await writeFile(join(extRoot, "marker.txt"), "old");

      const stopExtensionClient = mock(async () => {});
      const extractPackage = mock(async () => {
        throw new Error("should not reach extract");
      });
      const perform = createPerformUpgrade({
        extensionsRoot: join(root, "extensions"),
        reverifyManifest: async () => {},
        fetchPackage: async () => new Uint8Array([1, 2, 3]),
        signal: new AbortController().signal,
        sha256OfPackage: async () => "0".repeat(64), // mismatch
        extractPackage,
        stopExtensionClient,
        dbUpdateExtensionRow: async () => {},
      });

      await expect(perform(mkAvailable())).rejects.toThrow(/sha256_mismatch/);
      expect(stopExtensionClient).not.toHaveBeenCalled();
      expect(extractPackage).not.toHaveBeenCalled();
      expect(await readFile(join(extRoot, "marker.txt"), "utf8")).toBe("old");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("apply refuses when the re-fetched manifest signature fails, before the package is fetched", async () => {
    const root = await mkdtemp(join(tmpdir(), "nimbus-orchestrate-"));
    try {
      const extRoot = join(root, "extensions", "com.example.a");
      await mkdir(extRoot, { recursive: true });
      await writeFile(join(extRoot, "marker.txt"), "old");
      const fetchPackage = mock(async () => new Uint8Array([1]));
      const dbUpdateExtensionRow = mock(async () => {});
      const perform = createPerformUpgrade({
        extensionsRoot: join(root, "extensions"),
        reverifyManifest: async () => {
          throw new Error("signature_failed: ERR_REGISTRY_SIGNATURE_INVALID: does not verify");
        },
        fetchPackage,
        signal: new AbortController().signal,
        sha256OfPackage: async () => "f".repeat(64),
        extractPackage: async () => {
          throw new Error("should not reach extract");
        },
        stopExtensionClient: async () => {},
        dbUpdateExtensionRow,
      });
      await expect(perform(mkAvailable())).rejects.toThrow(/^signature_failed/);
      expect(fetchPackage).not.toHaveBeenCalled();
      expect(dbUpdateExtensionRow).not.toHaveBeenCalled();
      expect(await readFile(join(extRoot, "marker.txt"), "utf8")).toBe("old");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("a package that cannot be fetched fails as download_failed", async () => {
    const root = await mkdtemp(join(tmpdir(), "nimbus-orchestrate-"));
    try {
      await mkdir(join(root, "extensions", "com.example.a"), { recursive: true });
      const perform = createPerformUpgrade({
        extensionsRoot: join(root, "extensions"),
        reverifyManifest: async () => {},
        fetchPackage: async () => {
          throw new Error("ERR_REGISTRY_UNREACHABLE: registry answered HTTP 503");
        },
        signal: new AbortController().signal,
        sha256OfPackage: async () => "f".repeat(64),
        extractPackage: async () => {
          throw new Error("should not reach extract");
        },
        stopExtensionClient: async () => {},
        dbUpdateExtensionRow: async () => {},
      });
      await expect(perform(mkAvailable())).rejects.toThrow(
        /^download_failed: ERR_REGISTRY_UNREACHABLE/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /** An upgrade whose fetch fails with `thrown`; nothing past the fetch may run. */
  async function upgradeFailingFetch(thrown: unknown): Promise<unknown> {
    const root = await mkdtemp(join(tmpdir(), "nimbus-orchestrate-fetch-"));
    try {
      const sha256OfPackage = mock(async () => "f".repeat(64));
      const perform = createPerformUpgrade({
        extensionsRoot: join(root, "extensions"),
        reverifyManifest: async () => {},
        fetchPackage: async () => {
          throw thrown;
        },
        signal: new AbortController().signal,
        sha256OfPackage,
        extractPackage: async () => {
          throw new Error("should not reach extract");
        },
        stopExtensionClient: async () => {},
        dbUpdateExtensionRow: async () => {},
      });
      const err = await perform(mkAvailable()).catch((e: unknown) => e);
      expect(sha256OfPackage).not.toHaveBeenCalled();
      return err;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it("a source registry gone since detection keeps its own phase, not download_failed", async () => {
    const err = await upgradeFailingFetch(
      new Error("source_registry_changed: registry main was removed"),
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("source_registry_changed: registry main was removed");
  });

  it("a non-Error fetch failure is stringified into download_failed", async () => {
    const err = await upgradeFailingFetch("socket hang up");
    expect((err as Error).message).toBe("download_failed: socket hang up");
  });

  it("a non-Error source_registry_changed fetch failure also keeps its own phase", async () => {
    const err = await upgradeFailingFetch("source_registry_changed: gone");
    expect((err as Error).message).toBe("source_registry_changed: gone");
  });

  it("accepts a package hash reported in upper-case hex (comparison is case-insensitive)", async () => {
    const root = await mkdtemp(join(tmpdir(), "nimbus-orchestrate-case-"));
    try {
      const extractPackage = mock(async () => {
        throw new Error("reached extract");
      });
      const perform = createPerformUpgrade({
        extensionsRoot: join(root, "extensions"),
        reverifyManifest: async () => {},
        fetchPackage: async () => new TextEncoder().encode("pkg"),
        signal: new AbortController().signal,
        sha256OfPackage: async () => "F".repeat(64),
        extractPackage,
        stopExtensionClient: async () => {},
        dbUpdateExtensionRow: async () => {},
      });
      // Past the hash check: the next step (extract) is what fails, not sha256_mismatch.
      await expect(perform(mkAvailable())).rejects.toThrow("reached extract");
      expect(extractPackage).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cleans up pendingDir and throws swap_failed when applyUpgradeSwap throws", async () => {
    // Trigger: extensionsRoot points to a temp dir where the extension's install
    // directory does NOT exist. applyUpgradeSwap's rename(installPath, newPrevPath)
    // throws ENOENT → the catch block fires → rejects with "swap_failed: ...".
    const root = await mkdtemp(join(tmpdir(), "nimbus-orchestrate-swap-fail-"));
    let pendingDir: string | undefined;
    try {
      // extensionsRoot exists but com.example.a does NOT — intentional.
      const extensionsRoot = join(root, "extensions");
      await mkdir(extensionsRoot, { recursive: true });

      const tarballBytes = new TextEncoder().encode("fake-tarball");
      const stopExtensionClient = mock(async (_id: string) => {});
      const dbUpdateExtensionRow = mock(
        async (
          _id: string,
          _version: string,
          _manifestHash: string,
          _entryHash: string,
          _treeDigest: string,
        ) => {},
      );

      // extractPackage creates the pendingDir so applyUpgradeSwap can reach the rename.
      const extractPackage = mock(async (_archive: string, destDir: string) => {
        pendingDir = destDir;
        await writePackage(destDir, MANIFEST_V11, "entry-v1.1");
        return { sourceRoot: destDir, treeDigest: "d".repeat(64) };
      });

      const perform = createPerformUpgrade({
        extensionsRoot,
        reverifyManifest: async () => {},
        fetchPackage: async () => tarballBytes,
        signal: new AbortController().signal,
        // Return exactly update.packageSha256 so the package check passes.
        sha256OfPackage: async () => "f".repeat(64),
        extractPackage,
        stopExtensionClient,
        dbUpdateExtensionRow,
      });

      const err = await perform(mkAvailable()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/^swap_failed:/);

      // pendingDir must have been removed by the catch cleanup.
      if (pendingDir !== undefined) {
        const { stat: fsStat } = await import("node:fs/promises");
        await expect(fsStat(pendingDir)).rejects.toThrow();
      }

      // db row and stopExtensionClient must NOT have been called on failure.
      expect(dbUpdateExtensionRow).not.toHaveBeenCalled();
      expect(stopExtensionClient).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("a refused package leaves the installed version and digest untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "nimbus-orchestrate-refused-"));
    try {
      const extRoot = join(root, "extensions", "com.example.a");
      await mkdir(extRoot, { recursive: true });
      await writeFile(join(extRoot, "marker.txt"), "old");
      const dbUpdateExtensionRow = mock(async () => {});
      const stopExtensionClient = mock(async () => {});
      const perform = createPerformUpgrade({
        extensionsRoot: join(root, "extensions"),
        reverifyManifest: async () => {},
        fetchPackage: async () => new Uint8Array([1, 2, 3]),
        signal: new AbortController().signal,
        sha256OfPackage: async () => "f".repeat(64),
        extractPackage: async () => {
          throw new Error("package_entry_refused: evil (SymbolicLink)");
        },
        stopExtensionClient,
        dbUpdateExtensionRow,
      });
      await expect(perform(mkAvailable())).rejects.toThrow(/package_entry_refused/);
      expect(await readFile(join(extRoot, "marker.txt"), "utf8")).toBe("old");
      expect(dbUpdateExtensionRow).not.toHaveBeenCalled();
      expect(stopExtensionClient).not.toHaveBeenCalled();
      // The temp archive is gone too, on the failure path.
      expect(await readdir(join(root, "extensions"))).toEqual(["com.example.a"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("a successful upgrade leaves no pending directory or temp archive behind", async () => {
    const root = await mkdtemp(join(tmpdir(), "nimbus-orchestrate-clean-"));
    try {
      const extensionsRoot = join(root, "extensions");
      const extRoot = join(extensionsRoot, "com.example.a");
      await mkdir(extRoot, { recursive: true });
      await writeFile(join(extRoot, "marker.txt"), "old");

      // The package sits inside ONE top-level folder, so sourceRoot differs from the extraction dir.
      const build = join(root, "build");
      await writePackage(join(build, "pkg"), MANIFEST_V11, "entry-v1.1");
      const archive = join(root, "pkg.tgz");
      await tar.c({ gzip: true, file: archive, cwd: build }, ["pkg"]);
      const archiveBytes = new Uint8Array(await readFile(archive));

      const dbUpdateExtensionRow = mock(async () => {});
      const perform = createPerformUpgrade({
        extensionsRoot,
        reverifyManifest: async () => {},
        fetchPackage: async () => archiveBytes,
        signal: new AbortController().signal,
        sha256OfPackage: async () => "f".repeat(64),
        extractPackage: realExtractPackage,
        stopExtensionClient: async () => {},
        dbUpdateExtensionRow,
      });
      await perform(mkAvailable());

      expect(await readFile(join(extRoot, "dist", "index.js"), "utf8")).toBe("entry-v1.1");
      expect(dbUpdateExtensionRow).toHaveBeenCalledWith(
        "com.example.a",
        "1.1.0",
        sha(MANIFEST_V11),
        sha("entry-v1.1"),
        expect.stringMatching(/^[0-9a-f]{64}$/),
      );
      const pending = pendingVersionDir(extensionsRoot, "com.example.a", "1.1.0");
      expect(existsSync(pending)).toBe(false);
      expect(existsSync(`${pending}.tgz`)).toBe(false);
      expect((await readdir(dirname(pending))).filter((n) => n.endsWith(".tgz"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("a cleanup that throws after a committed swap still resolves and still stops the client", async () => {
    const root = await mkdtemp(join(tmpdir(), "nimbus-orchestrate-"));
    try {
      const extRoot = join(root, "extensions", "com.example.a");
      await mkdir(extRoot, { recursive: true });
      await writeFile(join(extRoot, "marker.txt"), "old");
      const stopExtensionClient = mock(async (_id: string) => {});
      const dbUpdateExtensionRow = mock(async () => {});
      const removePath = mock(async (_p: string) => {
        throw new Error("EBUSY: resource busy or locked");
      });
      const perform = createPerformUpgrade({
        extensionsRoot: join(root, "extensions"),
        reverifyManifest: async () => {},
        fetchPackage: async () => new Uint8Array([1]),
        signal: new AbortController().signal,
        sha256OfPackage: async () => "f".repeat(64),
        extractPackage: async (_archive: string, destDir: string) => {
          await writePackage(destDir, MANIFEST_V11, "entry-v1.1");
          await writeFile(join(destDir, "marker.txt"), "new");
          return { sourceRoot: destDir, treeDigest: "d".repeat(64) };
        },
        stopExtensionClient,
        dbUpdateExtensionRow,
        removePath,
      });

      await perform(mkAvailable());

      expect(removePath).toHaveBeenCalledTimes(2);
      expect(dbUpdateExtensionRow).toHaveBeenCalledTimes(1);
      expect(stopExtensionClient).toHaveBeenCalledWith("com.example.a");
      expect(await readFile(join(extRoot, "marker.txt"), "utf8")).toBe("new");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("createPerformDowngrade", () => {
  it("swaps the install dir and prev/<to>, invalidates mesh, updates extension row", async () => {
    const root = await mkdtemp(join(tmpdir(), "nimbus-orchestrate-down-"));
    try {
      const extRoot = join(root, "extensions", "com.example.a");
      await mkdir(extRoot, { recursive: true });
      await writeFile(join(extRoot, "marker.txt"), "vNew");
      await writePackage(
        prevVersionDir(join(root, "extensions"), "com.example.a", "1.0.0"),
        MANIFEST_V10,
        "entry-v1.0",
      );
      await writeFile(
        join(prevVersionDir(join(root, "extensions"), "com.example.a", "1.0.0"), "marker.txt"),
        "vOld",
      );

      const stopExtensionClient = mock(async () => {});
      const dbUpdateExtensionRow = mock(async () => {});
      const perform = createPerformDowngrade({
        extensionsRoot: join(root, "extensions"),
        stopExtensionClient,
        dbUpdateExtensionRow,
      });

      await perform(
        mkAvailable({
          fromVersion: "1.1.0",
          toVersion: "1.0.0",
          manifestHash: sha(MANIFEST_V10),
          entryHash: sha("entry-v1.0"),
        }),
      );

      expect(await readFile(join(extRoot, "marker.txt"), "utf8")).toBe("vOld");
      expect(stopExtensionClient).toHaveBeenCalledWith("com.example.a");
      expect(dbUpdateExtensionRow).toHaveBeenCalledWith(
        "com.example.a",
        "1.0.0",
        sha(MANIFEST_V10),
        sha("entry-v1.0"),
        expect.stringMatching(/^[0-9a-f]{64}$/),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a missing _prev/<to> as downgrade_unavailable without touching the row", async () => {
    const root = await mkdtemp(join(tmpdir(), "nimbus-orchestrate-down-"));
    try {
      const extRoot = join(root, "extensions", "com.example.a");
      await mkdir(extRoot, { recursive: true });
      await writeFile(join(extRoot, "marker.txt"), "vNew");
      const stopExtensionClient = mock(async () => {});
      const dbUpdateExtensionRow = mock(async () => {});
      const perform = createPerformDowngrade({
        extensionsRoot: join(root, "extensions"),
        stopExtensionClient,
        dbUpdateExtensionRow,
      });
      await expect(
        perform(mkAvailable({ fromVersion: "1.1.0", toVersion: "1.0.0" })),
      ).rejects.toThrow(/downgrade_unavailable/);
      expect(await readFile(join(extRoot, "marker.txt"), "utf8")).toBe("vNew");
      expect(dbUpdateExtensionRow).not.toHaveBeenCalled();
      expect(stopExtensionClient).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a _prev package that differs from the registry's claims, before the swap", async () => {
    const root = await mkdtemp(join(tmpdir(), "nimbus-orchestrate-down-"));
    try {
      const extRoot = join(root, "extensions", "com.example.a");
      await mkdir(extRoot, { recursive: true });
      await writeFile(join(extRoot, "marker.txt"), "vNew");
      await writePackage(
        prevVersionDir(join(root, "extensions"), "com.example.a", "1.0.0"),
        MANIFEST_V10,
        "edited-on-disk",
      );

      const stopExtensionClient = mock(async () => {});
      const dbUpdateExtensionRow = mock(async () => {});
      const perform = createPerformDowngrade({
        extensionsRoot: join(root, "extensions"),
        stopExtensionClient,
        dbUpdateExtensionRow,
      });

      await expect(
        perform(
          mkAvailable({
            fromVersion: "1.1.0",
            toVersion: "1.0.0",
            manifestHash: sha(MANIFEST_V10),
            entryHash: sha("entry-v1.0"),
          }),
        ),
      ).rejects.toThrow(/package_hash_mismatch: entry/);
      expect(await readFile(join(extRoot, "marker.txt"), "utf8")).toBe("vNew");
      expect(dbUpdateExtensionRow).not.toHaveBeenCalled();
      expect(stopExtensionClient).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("createPerformUpgrade: the approved plan's dependency step", () => {
  const ID = "com.example.a";
  const DEP_EDGES = [{ id: "com.example.dep", version: "1.0.0", deps: [] }];

  /** A plan whose resolver is never consulted by the orchestrator itself. */
  function planAdding(ids: readonly string[]): UpdatePlan {
    const resolver: RegistryDependencyResolver = {
      fetcher: {
        targetSource: () => null,
        listVersions: () => Promise.resolve([]),
        fetchManifest: () => Promise.reject(new Error("unused")),
      },
      rootSource: sourceKey("main", "c".repeat(32)),
      readRootIndex: () => Promise.reject(new Error("unused")),
      verified: () => undefined,
      registryUrl: () => null,
      stage: () => Promise.reject(new Error("unused")),
    };
    return {
      resolver,
      plan: { nodes: [] },
      addedPackages: ids.map((id) => ({
        id,
        version: "1.0.0",
        registry: "main",
        registryUrl: null,
      })),
    };
  }

  async function withInstalledRoot<T>(run: (extensionsRoot: string) => Promise<T>): Promise<T> {
    const root = await mkdtemp(join(tmpdir(), "nimbus-orchestrate-deps-"));
    try {
      const extRoot = join(root, "extensions", ID);
      await mkdir(extRoot, { recursive: true });
      await writeFile(join(extRoot, "marker.txt"), "old");
      return await run(join(root, "extensions"));
    } finally {
      rmDirWithRetry(root);
    }
  }

  const baseDeps = (extensionsRoot: string) => ({
    extensionsRoot,
    reverifyManifest: async () => {},
    fetchPackage: async () => new Uint8Array([1]),
    signal: new AbortController().signal,
    sha256OfPackage: async () => "f".repeat(64),
    extractPackage: async (_archive: string, destDir: string) => {
      await writePackage(destDir, MANIFEST_V11, "entry-v1.1");
      await writeFile(join(destDir, "marker.txt"), "new");
      return { sourceRoot: destDir, treeDigest: "d".repeat(64) };
    },
    stopExtensionClient: async () => {},
  });

  it("runs after the package is measured and before the swap, and its edges commit with the row", async () => {
    await withInstalledRoot(async (extensionsRoot) => {
      const plan = planAdding(["com.example.dep"]);
      let markerAtStep: string | undefined;
      const installDependencies = mock(async (_u: AvailableUpdate, p: UpdatePlan | undefined) => {
        expect(p).toBe(plan);
        markerAtStep = await readFile(join(extensionsRoot, ID, "marker.txt"), "utf8");
        return { edges: DEP_EDGES, rollback: () => [] };
      });
      const dbUpdateExtensionRow = mock(
        async (
          _id: string,
          _version: string,
          _manifestHash: string,
          _entryHash: string,
          _treeDigest: string,
          _edges?: readonly unknown[],
        ) => {},
      );
      const perform = createPerformUpgrade({
        ...baseDeps(extensionsRoot),
        installDependencies,
        dbUpdateExtensionRow,
      });
      await perform(mkAvailable(), plan);
      expect(installDependencies).toHaveBeenCalledTimes(1);
      expect(markerAtStep).toBe("old");
      expect(await readFile(join(extensionsRoot, ID, "marker.txt"), "utf8")).toBe("new");
      expect(dbUpdateExtensionRow).toHaveBeenCalledWith(
        ID,
        "1.1.0",
        sha(MANIFEST_V11),
        sha("entry-v1.1"),
        "d".repeat(64),
        DEP_EDGES,
      );
    });
  });

  it("a refused package never reaches the dependency step", async () => {
    await withInstalledRoot(async (extensionsRoot) => {
      const installDependencies = mock(async () => ({ edges: [], rollback: () => [] }));
      const perform = createPerformUpgrade({
        ...baseDeps(extensionsRoot),
        extractPackage: async (_archive: string, destDir: string) => {
          await writePackage(destDir, MANIFEST_V11, "tampered-entry");
          return { sourceRoot: destDir, treeDigest: "d".repeat(64) };
        },
        installDependencies,
        dbUpdateExtensionRow: async () => {},
      });
      await expect(perform(mkAvailable(), planAdding(["com.example.dep"]))).rejects.toThrow(
        /package_hash_mismatch: entry/,
      );
      expect(installDependencies).not.toHaveBeenCalled();
    });
  });

  it("a failed swap rolls the dependency step back", async () => {
    const root = await mkdtemp(join(tmpdir(), "nimbus-orchestrate-deps-swap-"));
    try {
      // No install directory: the swap's first rename fails.
      const extensionsRoot = join(root, "extensions");
      await mkdir(extensionsRoot, { recursive: true });
      const rollback = mock(() => []);
      const dbUpdateExtensionRow = mock(async () => {});
      const perform = createPerformUpgrade({
        ...baseDeps(extensionsRoot),
        installDependencies: async () => ({ edges: DEP_EDGES, rollback }),
        dbUpdateExtensionRow,
      });
      await expect(perform(mkAvailable(), planAdding(["com.example.dep"]))).rejects.toThrow(
        /^swap_failed: /,
      );
      expect(rollback).toHaveBeenCalledTimes(1);
      expect(dbUpdateExtensionRow).not.toHaveBeenCalled();
    } finally {
      rmDirWithRetry(root);
    }
  });

  it("a failed row write restores the old root, then rolls the dependency step back", async () => {
    await withInstalledRoot(async (extensionsRoot) => {
      const order: string[] = [];
      const rollback = mock(() => {
        order.push(`rollback:${existsSync(join(extensionsRoot, ID, "dist")) ? "new" : "old"}`);
        return [];
      });
      const stopExtensionClient = mock(async () => {});
      const perform = createPerformUpgrade({
        ...baseDeps(extensionsRoot),
        stopExtensionClient,
        installDependencies: async () => ({ edges: DEP_EDGES, rollback }),
        dbUpdateExtensionRow: async () => {
          throw new Error("SQLITE_BUSY");
        },
      });
      await expect(perform(mkAvailable(), planAdding(["com.example.dep"]))).rejects.toThrow(
        /^swap_failed: SQLITE_BUSY/,
      );
      expect(await readFile(join(extensionsRoot, ID, "marker.txt"), "utf8")).toBe("old");
      // The old root was back in place before the dependencies were undone.
      expect(order).toEqual(["rollback:old"]);
      expect(existsSync(prevVersionDir(extensionsRoot, ID, "1.0.0"))).toBe(false);
      expect(stopExtensionClient).not.toHaveBeenCalled();
    });
  });

  it("a row write that fails without a dependency step still restores the old root", async () => {
    await withInstalledRoot(async (extensionsRoot) => {
      const perform = createPerformUpgrade({
        ...baseDeps(extensionsRoot),
        dbUpdateExtensionRow: async () => {
          throw new Error("disk full");
        },
      });
      await expect(perform(mkAvailable())).rejects.toThrow(/^swap_failed: disk full/);
      expect(await readFile(join(extensionsRoot, ID, "marker.txt"), "utf8")).toBe("old");
    });
  });

  it("without a dependency step, a plan that adds packages is refused before the swap", async () => {
    await withInstalledRoot(async (extensionsRoot) => {
      const dbUpdateExtensionRow = mock(async () => {});
      const perform = createPerformUpgrade({ ...baseDeps(extensionsRoot), dbUpdateExtensionRow });
      await expect(perform(mkAvailable(), planAdding(["com.example.dep"]))).rejects.toThrow(
        /^update_conflicts: /,
      );
      expect(dbUpdateExtensionRow).not.toHaveBeenCalled();
      expect(await readFile(join(extensionsRoot, ID, "marker.txt"), "utf8")).toBe("old");
      // A plan that adds nothing needs no step.
      await perform(mkAvailable(), planAdding([]));
      expect(dbUpdateExtensionRow).toHaveBeenCalledTimes(1);
    });
  });
});
