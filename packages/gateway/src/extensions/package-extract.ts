import { mkdirSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import * as tar from "tar";

import { extractTarGzToDirectory } from "./install-from-local.ts";
import { resolveExtensionManifestPath } from "./manifest.ts";
import { computeExtensionTreeDigest } from "./tree-digest.ts";

/** Total declared (unpacked) bytes an extension package may carry. */
export const MAX_UNPACKED_BYTES = 200 * 1024 * 1024;
/** Total entries (files and directories) an extension package may carry. */
export const MAX_PACKAGE_ENTRIES = 5000;

export type ExtractedPackage = { sourceRoot: string; treeDigest: string };

function hasEscapingPath(path: string): boolean {
  if (isAbsolute(path) || path.startsWith("/") || path.startsWith("\\")) return true;
  return path.split(/[/]/).includes("..");
}

/**
 * Reads the archive's headers only, writing nothing, and refuses a package that is too large, has too
 * many entries, or carries anything but plain files and directories (links, devices, FIFOs) or a path
 * that is absolute or climbs with `..`. Declared sizes are summed, so an archive cannot hide its
 * weight from this scan; the tar extractor then runs only on an archive that passed.
 */
async function scanPackage(archivePath: string): Promise<void> {
  let entries = 0;
  let bytes = 0;
  let refused: string | undefined;
  await tar.t({
    file: archivePath,
    onReadEntry: (entry) => {
      entries += 1;
      bytes += entry.size;
      if (refused === undefined && entry.type !== "File" && entry.type !== "Directory") {
        refused = `${entry.path} (${entry.type})`;
      } else if (refused === undefined && hasEscapingPath(entry.path)) {
        refused = entry.path;
      }
    },
  });
  if (refused !== undefined) {
    throw new Error(`package_entry_refused: ${refused}`);
  }
  if (entries > MAX_PACKAGE_ENTRIES) {
    throw new Error(
      `package_too_large: ${String(entries)} entries (max ${String(MAX_PACKAGE_ENTRIES)})`,
    );
  }
  if (bytes > MAX_UNPACKED_BYTES) {
    throw new Error(
      `package_too_large: ${String(bytes)} bytes unpacked (max ${String(MAX_UNPACKED_BYTES)})`,
    );
  }
}

export function findExtensionSourceRootInTree(extractedRoot: string): string {
  if (resolveExtensionManifestPath(extractedRoot) !== undefined) {
    return extractedRoot;
  }
  for (const ent of readdirSync(extractedRoot, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      const sub = join(extractedRoot, ent.name);
      if (resolveExtensionManifestPath(sub) !== undefined) {
        return sub;
      }
    }
  }
  throw new Error(
    "archive does not contain nimbus.extension.json (at root or one subdirectory deep)",
  );
}

/**
 * The one way an extension archive becomes a directory, for install and update alike: scan the
 * headers against the caps, extract, find the package root, and digest it — all before the caller
 * moves a byte into an install path.
 */
export async function extractPackage(
  archivePath: string,
  destDir: string,
): Promise<ExtractedPackage> {
  await scanPackage(archivePath);
  mkdirSync(destDir, { recursive: true });
  extractTarGzToDirectory(archivePath, destDir);
  const sourceRoot = findExtensionSourceRootInTree(destDir);
  return { sourceRoot, treeDigest: computeExtensionTreeDigest(sourceRoot) };
}
