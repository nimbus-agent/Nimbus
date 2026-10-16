import { describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPerformDowngrade, createPerformUpgrade } from "./auto-update-orchestrate.ts";
import type { AvailableUpdate } from "./auto-update-types.ts";

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
        await writePackage(destDir, MANIFEST_V11, "entry-v1.1");
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
          return "f".repeat(64);
        },
        extractTarball,
        stopExtensionClient,
        dbUpdateExtensionRow,
      });

      await perform(mkAvailable());

      expect(await readFile(join(extRoot, "active", "marker.txt"), "utf8")).toBe("new");
      expect(stopExtensionClient).toHaveBeenCalledWith("com.example.a");
      // The row gets the ENTRY FILE's hash — what startup verification re-measures — never the
      // tarball's.
      expect(dbUpdateExtensionRow).toHaveBeenCalledWith(
        "com.example.a",
        "1.1.0",
        sha(MANIFEST_V11),
        sha("entry-v1.1"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("checks the TARBALL against tarballSha256, not entryHash", async () => {
    const root = await mkdtemp(join(tmpdir(), "nimbus-orchestrate-"));
    try {
      await mkdir(join(root, "extensions", "com.example.a", "active"), { recursive: true });
      const extractTarball = mock(async () => {});
      const perform = createPerformUpgrade({
        extensionsRoot: join(root, "extensions"),
        dataDir: join(root, "data"),
        fetcher: (async () =>
          new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as unknown as typeof fetch,
        maxBytes: 1024,
        signal: new AbortController().signal,
        // Equal to entryHash: the old check accepted this tarball; the fixed one must not.
        sha256OfTarball: async () => sha("entry-v1.1"),
        extractTarball,
        stopExtensionClient: async () => {},
        dbUpdateExtensionRow: async () => {},
      });
      await expect(perform(mkAvailable())).rejects.toThrow(/sha256_mismatch/);
      expect(extractTarball).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a tarball whose extracted entry differs from entryHash, before the swap", async () => {
    const root = await mkdtemp(join(tmpdir(), "nimbus-orchestrate-"));
    let pendingDir: string | undefined;
    try {
      const extRoot = join(root, "extensions", "com.example.a");
      await mkdir(join(extRoot, "active"), { recursive: true });
      await writeFile(join(extRoot, "active", "marker.txt"), "old");
      const stopExtensionClient = mock(async () => {});
      const dbUpdateExtensionRow = mock(async () => {});
      const perform = createPerformUpgrade({
        extensionsRoot: join(root, "extensions"),
        dataDir: join(root, "data"),
        fetcher: (async () =>
          new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as unknown as typeof fetch,
        maxBytes: 1024,
        signal: new AbortController().signal,
        sha256OfTarball: async () => "f".repeat(64),
        extractTarball: async (_bytes, destDir) => {
          pendingDir = destDir;
          await writePackage(destDir, MANIFEST_V11, "tampered-entry");
        },
        stopExtensionClient,
        dbUpdateExtensionRow,
      });

      await expect(perform(mkAvailable())).rejects.toThrow(/package_hash_mismatch: entry/);
      expect(await readFile(join(extRoot, "active", "marker.txt"), "utf8")).toBe("old");
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
        await writePackage(destDir, MANIFEST_V11, "entry-v1.1");
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
        // Return exactly update.tarballSha256 so the tarball check passes.
        sha256OfTarball: async () => "f".repeat(64),
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
      await writePackage(join(extRoot, "_prev", "1.0.0"), MANIFEST_V10, "entry-v1.0");
      await writeFile(join(extRoot, "_prev", "1.0.0", "marker.txt"), "vOld");

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

      expect(await readFile(join(extRoot, "active", "marker.txt"), "utf8")).toBe("vOld");
      expect(stopExtensionClient).toHaveBeenCalledWith("com.example.a");
      expect(dbUpdateExtensionRow).toHaveBeenCalledWith(
        "com.example.a",
        "1.0.0",
        sha(MANIFEST_V10),
        sha("entry-v1.0"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a _prev package that differs from the registry's claims, before the swap", async () => {
    const root = await mkdtemp(join(tmpdir(), "nimbus-orchestrate-down-"));
    try {
      const extRoot = join(root, "extensions", "com.example.a");
      await mkdir(join(extRoot, "active"), { recursive: true });
      await writeFile(join(extRoot, "active", "marker.txt"), "vNew");
      await writePackage(join(extRoot, "_prev", "1.0.0"), MANIFEST_V10, "edited-on-disk");

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
      expect(await readFile(join(extRoot, "active", "marker.txt"), "utf8")).toBe("vNew");
      expect(dbUpdateExtensionRow).not.toHaveBeenCalled();
      expect(stopExtensionClient).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
