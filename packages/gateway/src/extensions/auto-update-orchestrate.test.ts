import { describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPerformDowngrade, createPerformUpgrade } from "./auto-update-orchestrate.ts";
import type { AvailableUpdate } from "./auto-update-types.ts";

function mkAvailable(overrides: Partial<AvailableUpdate> = {}): AvailableUpdate {
  return {
    id: "com.example.a",
    displayName: "A",
    fromVersion: "1.0.0",
    toVersion: "1.1.0",
    channel: "stable",
    changelog: "",
    publisherStatus: "verified",
    manifestHash: "d".repeat(64),
    signatureB64: `${"B".repeat(86)}==`,
    entryHash: "e".repeat(64),
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
      await mkdir(join(extRoot, "active"), { recursive: true });
      await writeFile(join(extRoot, "active", "marker.txt"), "old");

      const dataDir = join(root, "data");
      await mkdir(join(dataDir, "extensions"), { recursive: true });

      const tarballBytes = new TextEncoder().encode("fake-tarball-bytes");
      const stopExtensionClient = mock(async (_id: string) => {});
      const dbUpdateExtensionRow = mock(
        async (_id: string, _version: string, _manifestHash: string, _entryHash: string) => {},
      );
      const extractTarball = mock(async (_bytes: Uint8Array, destDir: string) => {
        await mkdir(destDir, { recursive: true });
        await writeFile(join(destDir, "marker.txt"), "new");
      });

      const perform = createPerformUpgrade({
        extensionsRoot: join(root, "extensions"),
        dataDir,
        fetcher: (async () =>
          new Response(tarballBytes, {
            status: 200,
            headers: { "content-length": String(tarballBytes.byteLength) },
          })) as unknown as typeof fetch,
        maxBytes: 1024,
        signal: new AbortController().signal,
        sha256OfTarball: async (b) => {
          expect(b).toEqual(tarballBytes);
          return "e".repeat(64);
        },
        extractTarball,
        stopExtensionClient,
        dbUpdateExtensionRow,
      });

      await perform(mkAvailable());

      expect(await readFile(join(extRoot, "active", "marker.txt"), "utf8")).toBe("new");
      expect(stopExtensionClient).toHaveBeenCalledWith("com.example.a");
      expect(dbUpdateExtensionRow).toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("throws sha256_mismatch before any disk mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "nimbus-orchestrate-"));
    try {
      const extRoot = join(root, "extensions", "com.example.a");
      await mkdir(join(extRoot, "active"), { recursive: true });
      await writeFile(join(extRoot, "active", "marker.txt"), "old");

      const stopExtensionClient = mock(async () => {});
      const extractTarball = mock(async () => {
        throw new Error("should not reach extract");
      });
      const perform = createPerformUpgrade({
        extensionsRoot: join(root, "extensions"),
        dataDir: join(root, "data"),
        fetcher: (async () =>
          new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as unknown as typeof fetch,
        maxBytes: 1024,
        signal: new AbortController().signal,
        sha256OfTarball: async () => "0".repeat(64), // mismatch
        extractTarball,
        stopExtensionClient,
        dbUpdateExtensionRow: async () => {},
      });

      await expect(perform(mkAvailable())).rejects.toThrow(/sha256_mismatch/);
      expect(stopExtensionClient).not.toHaveBeenCalled();
      expect(extractTarball).not.toHaveBeenCalled();
      expect(await readFile(join(extRoot, "active", "marker.txt"), "utf8")).toBe("old");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cleans up pendingDir and throws swap_failed when applyUpgradeSwap throws", async () => {
    // Trigger: extensionsRoot points to a temp dir where the extension's `active`
    // directory does NOT exist. applyUpgradeSwap's rename(activePath, newPrevPath)
    // throws ENOENT → the catch block fires → rejects with "swap_failed: ...".
    const root = await mkdtemp(join(tmpdir(), "nimbus-orchestrate-swap-fail-"));
    let pendingDir: string | undefined;
    try {
      // extensionsRoot exists but com.example.a/active does NOT — intentional.
      const extensionsRoot = join(root, "extensions");
      await mkdir(extensionsRoot, { recursive: true });

      const dataDir = join(root, "data");
      await mkdir(join(dataDir, "extensions"), { recursive: true });

      const tarballBytes = new TextEncoder().encode("fake-tarball");
      const stopExtensionClient = mock(async (_id: string) => {});
      const dbUpdateExtensionRow = mock(
        async (_id: string, _version: string, _manifestHash: string, _entryHash: string) => {},
      );

      // extractTarball creates the pendingDir so applyUpgradeSwap can reach the rename.
      const extractTarball = mock(async (_bytes: Uint8Array, destDir: string) => {
        pendingDir = destDir;
        await mkdir(destDir, { recursive: true });
      });

      const perform = createPerformUpgrade({
        extensionsRoot,
        dataDir,
        fetcher: (async () =>
          new Response(tarballBytes, {
            status: 200,
            headers: { "content-length": String(tarballBytes.byteLength) },
          })) as unknown as typeof fetch,
        maxBytes: 1024,
        signal: new AbortController().signal,
        // Return exactly update.entryHash so the hash check passes.
        sha256OfTarball: async () => "e".repeat(64),
        extractTarball,
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
});

describe("createPerformDowngrade", () => {
  it("swaps active and _prev/<to>, invalidates mesh, updates extension row", async () => {
    const root = await mkdtemp(join(tmpdir(), "nimbus-orchestrate-down-"));
    try {
      const extRoot = join(root, "extensions", "com.example.a");
      await mkdir(join(extRoot, "active"), { recursive: true });
      await writeFile(join(extRoot, "active", "marker.txt"), "vNew");
      await mkdir(join(extRoot, "_prev", "1.0.0"), { recursive: true });
      await writeFile(join(extRoot, "_prev", "1.0.0", "marker.txt"), "vOld");

      const stopExtensionClient = mock(async () => {});
      const dbUpdateExtensionRow = mock(async () => {});
      const perform = createPerformDowngrade({
        extensionsRoot: join(root, "extensions"),
        stopExtensionClient,
        dbUpdateExtensionRow,
      });

      await perform(mkAvailable({ fromVersion: "1.1.0", toVersion: "1.0.0" }));

      expect(await readFile(join(extRoot, "active", "marker.txt"), "utf8")).toBe("vOld");
      expect(stopExtensionClient).toHaveBeenCalledWith("com.example.a");
      expect(dbUpdateExtensionRow).toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
