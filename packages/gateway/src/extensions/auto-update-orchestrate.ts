import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { sha256HexEqualConstantTime } from "../util/timing-safe-compare.ts";
import { applyDowngradeSwap, applyUpgradeSwap } from "./auto-update-apply.ts";
import type { AvailableUpdate } from "./auto-update-types.ts";
import type { ExtractedPackage } from "./package-extract.ts";
import { assertPackageMatchesClaims } from "./package-hashes.ts";
import { computeExtensionTreeDigest } from "./tree-digest.ts";
import { pendingDir as pendingVersionDir, prevVersionDir } from "./version-store.ts";

export interface PerformUpgradeDeps {
  extensionsRoot: string;
  signal: AbortSignal;
  /**
   * Re-checks the update against its source registry's CURRENT signed index before anything is
   * downloaded: the index must still list this exact manifest and package, and the manifest must
   * verify with the index's publisher key (spec § 8.8 — apply verifies as § 8.6 steps 2–5).
   * Throws an error whose message starts `signature_failed` when it does not.
   */
  reverifyManifest: (update: AvailableUpdate, signal: AbortSignal) => Promise<unknown>;
  /** One ledgered `registry.package` fetch of `update.packagePath` from `update.sourceRegistry`. */
  fetchPackage: (update: AvailableUpdate, signal: AbortSignal) => Promise<Uint8Array>;
  sha256OfPackage: (bytes: Uint8Array) => Promise<string>;
  extractPackage: (archivePath: string, destDir: string) => Promise<ExtractedPackage>;
  stopExtensionClient: (extensionId: string) => Promise<void>;
  dbUpdateExtensionRow: (
    id: string,
    version: string,
    manifestHash: string,
    entryHash: string,
    treeDigest: string,
  ) => Promise<void>;
  /** Removes a cleanup path; defaults to `rm(..., { recursive: true, force: true })`. Test seam. */
  removePath?: (path: string) => Promise<void>;
}

async function defaultRemovePath(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

export function createPerformUpgrade(deps: PerformUpgradeDeps) {
  return async function performUpgrade(update: AvailableUpdate): Promise<void> {
    const pendingDir = pendingVersionDir(deps.extensionsRoot, update.id, update.toVersion);
    await mkdir(dirname(pendingDir), { recursive: true });
    await rm(pendingDir, { recursive: true, force: true });

    await deps.reverifyManifest(update, deps.signal);
    let bytes: Uint8Array;
    try {
      bytes = await deps.fetchPackage(update, deps.signal);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // A source registry gone since detection is its own phase, not a failed download.
      throw new Error(msg.startsWith("source_registry_changed") ? msg : `download_failed: ${msg}`);
    }

    const actualHash = await deps.sha256OfPackage(bytes);
    if (!sha256HexEqualConstantTime(actualHash, update.packageSha256)) {
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
      // Best-effort: once the row is updated the update IS committed, and a cleanup failure (an
      // EBUSY on Windows) must not report it as failed, skip the client stop and leave a stale
      // cache. A leftover pending dir is cleared by the next attempt's own `rm` above.
      // The two leftovers are disjoint (a directory and its sibling archive), so they are removed
      // concurrently; a rejection is ignored — see above.
      const removePath = deps.removePath ?? defaultRemovePath;
      await Promise.allSettled(
        [pendingDir, archivePath].map((leftover) => Promise.try(() => removePath(leftover))),
      );
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
