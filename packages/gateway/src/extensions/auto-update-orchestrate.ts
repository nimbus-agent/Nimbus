import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  applyDowngradeSwap,
  applyUpgradeSwap,
  downloadTarball,
  type FetchFn,
  MAX_TARBALL_BYTES,
} from "./auto-update-apply.ts";
import type { AvailableUpdate } from "./auto-update-types.ts";

export interface PerformUpgradeDeps {
  extensionsRoot: string;
  dataDir: string;
  fetcher: FetchFn;
  maxBytes?: number;
  signal: AbortSignal;
  sha256OfTarball: (bytes: Uint8Array) => Promise<string>;
  extractTarball: (bytes: Uint8Array, destDir: string) => Promise<void>;
  stopExtensionClient: (extensionId: string) => Promise<void>;
  dbUpdateExtensionRow: (
    id: string,
    version: string,
    manifestHash: string,
    entryHash: string,
  ) => Promise<void>;
}

export function createPerformUpgrade(deps: PerformUpgradeDeps) {
  return async function performUpgrade(update: AvailableUpdate): Promise<void> {
    const pendingDir = join(
      deps.dataDir,
      "extensions",
      "_pending",
      `${update.id}-${update.toVersion}`,
    );
    await mkdir(join(deps.dataDir, "extensions", "_pending"), { recursive: true });
    await rm(pendingDir, { recursive: true, force: true });

    const bytes = await downloadTarball(update.tarballUrl, {
      fetcher: deps.fetcher,
      maxBytes: deps.maxBytes ?? MAX_TARBALL_BYTES,
      signal: deps.signal,
    });

    const actualHash = await deps.sha256OfTarball(bytes);
    if (actualHash.toLowerCase() !== update.entryHash.toLowerCase()) {
      throw new Error("sha256_mismatch");
    }

    await deps.extractTarball(bytes, pendingDir);

    const extRoot = join(deps.extensionsRoot, update.id);
    try {
      await applyUpgradeSwap({
        extRoot,
        pendingExtractedDir: pendingDir,
        fromVersion: update.fromVersion,
        toVersion: update.toVersion,
      });
    } catch (e) {
      await rm(pendingDir, { recursive: true, force: true });
      throw new Error(`swap_failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    await deps.dbUpdateExtensionRow(
      update.id,
      update.toVersion,
      update.manifestHash,
      update.entryHash,
    );
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
  ) => Promise<void>;
}

export function createPerformDowngrade(deps: PerformDowngradeDeps) {
  return async function performDowngrade(update: AvailableUpdate): Promise<void> {
    const extRoot = join(deps.extensionsRoot, update.id);
    await applyDowngradeSwap({
      extRoot,
      fromVersion: update.fromVersion,
      toVersion: update.toVersion,
    });
    await deps.dbUpdateExtensionRow(
      update.id,
      update.toVersion,
      update.manifestHash,
      update.entryHash,
    );
    await deps.stopExtensionClient(update.id);
  };
}
