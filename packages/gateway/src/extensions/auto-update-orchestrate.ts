import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  applyDowngradeSwap,
  applyUpgradeSwap,
  downloadTarball,
  type FetchFn,
  MAX_TARBALL_BYTES,
} from "./auto-update-apply.ts";
import type { AvailableUpdate } from "./auto-update-types.ts";
import type { ExtractedPackage } from "./package-extract.ts";
import { assertPackageMatchesClaims } from "./package-hashes.ts";
import { computeExtensionTreeDigest } from "./tree-digest.ts";
import { pendingDir as pendingVersionDir, prevVersionDir } from "./version-store.ts";

export interface PerformUpgradeDeps {
  extensionsRoot: string;
  fetcher: FetchFn;
  maxBytes?: number;
  signal: AbortSignal;
  sha256OfTarball: (bytes: Uint8Array) => Promise<string>;
  extractPackage: (archivePath: string, destDir: string) => Promise<ExtractedPackage>;
  stopExtensionClient: (extensionId: string) => Promise<void>;
  dbUpdateExtensionRow: (
    id: string,
    version: string,
    manifestHash: string,
    entryHash: string,
    treeDigest: string,
  ) => Promise<void>;
}

export function createPerformUpgrade(deps: PerformUpgradeDeps) {
  return async function performUpgrade(update: AvailableUpdate): Promise<void> {
    const pendingDir = pendingVersionDir(deps.extensionsRoot, update.id, update.toVersion);
    await mkdir(dirname(pendingDir), { recursive: true });
    await rm(pendingDir, { recursive: true, force: true });

    const bytes = await downloadTarball(update.tarballUrl, {
      fetcher: deps.fetcher,
      maxBytes: deps.maxBytes ?? MAX_TARBALL_BYTES,
      signal: deps.signal,
    });

    const actualHash = await deps.sha256OfTarball(bytes);
    if (actualHash.toLowerCase() !== update.tarballSha256.toLowerCase()) {
      throw new Error("sha256_mismatch");
    }

    const archivePath = `${pendingDir}.tgz`;
    try {
      await writeFile(archivePath, bytes);
      const { sourceRoot, treeDigest } = await deps.extractPackage(archivePath, pendingDir);

      // `entryHash` names the entry FILE, which is what the row stores and startup verification
      // re-measures — so measure the extracted package and refuse before anything is swapped in.
      const measured = assertPackageMatchesClaims(sourceRoot, update);

      try {
        await applyUpgradeSwap({
          installPath: join(deps.extensionsRoot, update.id),
          extensionsDir: deps.extensionsRoot,
          id: update.id,
          pendingExtractedDir: sourceRoot,
          fromVersion: update.fromVersion,
          toVersion: update.toVersion,
        });
      } catch (e) {
        throw new Error(`swap_failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      await deps.dbUpdateExtensionRow(
        update.id,
        update.toVersion,
        measured.manifestHash,
        measured.entryHash,
        treeDigest,
      );
    } finally {
      // Whether the package was refused, the swap failed or it all worked, neither the pending
      // version directory (a nested package root is only renamed OUT of it) nor the archive stays.
      await rm(pendingDir, { recursive: true, force: true });
      await rm(archivePath, { force: true });
    }
    await deps.stopExtensionClient(update.id);
  };
}

export interface PerformDowngradeDeps {
  extensionsRoot: string;
  stopExtensionClient: (extensionId: string) => Promise<void>;
  dbUpdateExtensionRow: (
    id: string,
    version: string,
    manifestHash: string,
    entryHash: string,
    treeDigest: string,
  ) => Promise<void>;
}

export function createPerformDowngrade(deps: PerformDowngradeDeps) {
  return async function performDowngrade(update: AvailableUpdate): Promise<void> {
    const targetPrev = prevVersionDir(deps.extensionsRoot, update.id, update.toVersion);
    // Refused here rather than left to `applyDowngradeSwap`, so there is never an unmeasured
    // package whose hashes the row could be given.
    if (!existsSync(targetPrev)) {
      throw new Error("downgrade_unavailable");
    }
    const measured = assertPackageMatchesClaims(targetPrev, update);
    // Digested before the swap, so a tree that cannot be digested is refused with nothing moved.
    const treeDigest = computeExtensionTreeDigest(targetPrev);
    await applyDowngradeSwap({
      installPath: join(deps.extensionsRoot, update.id),
      extensionsDir: deps.extensionsRoot,
      id: update.id,
      fromVersion: update.fromVersion,
      toVersion: update.toVersion,
    });
    await deps.dbUpdateExtensionRow(
      update.id,
      update.toVersion,
      measured.manifestHash,
      measured.entryHash,
      treeDigest,
    );
    await deps.stopExtensionClient(update.id);
  };
}
