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
  /**
   * Hook to extract the downloaded tarball into `destDir`. Production wires
   * to the existing extension install pipeline's extractor; tests inject a
   * lightweight stub that writes a marker file.
   */
  extractTarball: (bytes: Uint8Array, destDir: string) => Promise<void>;
  /**
   * Drains in-flight calls and tears down the running MCP client for this
   * extension. Production binding: `mesh.stopExtensionClient.bind(mesh)`
   * (S7-F10 in mesh.ts; existing helper used by `extension.disable` and the
   * verify-extensions startup pass).
   */
  stopExtensionClient: (extensionId: string) => Promise<void>;
  /** dbRun-backed UPDATE of the `extension` row (version + manifest/entry hash). */
  dbUpdateExtensionRow: (
    id: string,
    version: string,
    manifestHash: string,
    entryHash: string,
  ) => Promise<void>;
}

/**
 * Compose the apply primitives (download → SHA-256 verify → extract →
 * atomic swap) and post-swap effects (DB row update + mesh client teardown
 * so the next spawn picks up the new code).
 *
 * Failure boundary: a thrown `sha256_mismatch` happens BEFORE any disk
 * mutation. A thrown `swap_failed` happens after `applyUpgradeSwap` could
 * not roll back; the pending dir is best-effort cleaned, but `active/` may
 * be in an intermediate state — the I14 startup crash recovery handles that
 * (Task 14).
 */
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

/**
 * Atomically swap `active/` with the cached `_prev/<toVersion>/` and tear
 * down the live MCP client so the next spawn picks up the older code.
 * Manifest / entry hash are taken from the cached AvailableUpdate; the
 * startup `verifyExtensionsBestEffort` re-validates them on next boot so a
 * tampered `_prev/` would be caught immediately.
 */
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
