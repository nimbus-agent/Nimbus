import { describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as tar from "tar";

import { createPerformDowngrade, createPerformUpgrade } from "./auto-update-orchestrate.ts";
import type { AvailableUpdate } from "./auto-update-types.ts";
import { extractPackage as realExtractPackage } from "./package-extract.ts";
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
    tarballSha256: "f".repeat(64),
    tarballUrl: "https://r/x.tar.gz",
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
        fetcher: (async () =>
          new Response(tarballBytes, {
            status: 200,
            headers: { "content-length": String(tarballBytes.byteLength) },
          })) as unknown as typeof fetch,
        maxBytes: 1024,
        signal: new AbortController().signal,
        sha256OfTarball: async (b) => {
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

  it("checks the TARBALL against tarballSha256, not entryHash", async () => {
    const root = await mkdtemp(join(tmpdir(), "nimbus-orchestrate-"));
    try {
      await mkdir(join(root, "extensions", "com.example.a"), { recursive: true });
      const extractPackage = mock(async () => ({ sourceRoot: "", treeDigest: "" }));
      const perform = createPerformUpgrade({
        extensionsRoot: join(root, "extensions"),
        fetcher: (async () =>
          new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as unknown as typeof fetch,
        maxBytes: 1024,
        signal: new AbortController().signal,
        // Equal to entryHash: the old check accepted this tarball; the fixed one must not.
        sha256OfTarball: async () => sha("entry-v1.1"),
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
        fetcher: (async () =>
          new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as unknown as typeof fetch,
        maxBytes: 1024,
        signal: new AbortController().signal,
        sha256OfTarball: async () => "f".repeat(64),
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

  it("throws sha256_mismatch before any disk mutation", async () => {
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
        fetcher: (async () =>
          new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as unknown as typeof fetch,
        maxBytes: 1024,
        signal: new AbortController().signal,
        sha256OfTarball: async () => "0".repeat(64), // mismatch
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
        fetcher: (async () =>
          new Response(tarballBytes, {
            status: 200,
            headers: { "content-length": String(tarballBytes.byteLength) },
          })) as unknown as typeof fetch,
        maxBytes: 1024,
        signal: new AbortController().signal,
        // Return exactly update.tarballSha256 so the tarball check passes.
        sha256OfTarball: async () => "f".repeat(64),
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
        fetcher: (async () =>
          new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as unknown as typeof fetch,
        maxBytes: 1024,
        signal: new AbortController().signal,
        sha256OfTarball: async () => "f".repeat(64),
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
        fetcher: (async () =>
          new Response(archiveBytes, { status: 200 })) as unknown as typeof fetch,
        maxBytes: 1024 * 1024,
        signal: new AbortController().signal,
        sha256OfTarball: async () => "f".repeat(64),
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
        fetcher: (async () =>
          new Response(new Uint8Array([1]), { status: 200 })) as unknown as typeof fetch,
        maxBytes: 1024 * 1024,
        signal: new AbortController().signal,
        sha256OfTarball: async () => "f".repeat(64),
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
