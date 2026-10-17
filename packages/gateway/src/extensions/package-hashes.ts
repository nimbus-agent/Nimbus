import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { sha256HexEqualConstantTime } from "../util/timing-safe-compare.ts";
import {
  extensionEntryRelPath,
  parseExtensionManifestJson,
  resolveExtensionManifestPath,
} from "./manifest.ts";

/**
 * The two hashes an `extension` row stores: SHA-256 of the manifest FILE and of the ENTRY FILE.
 * Startup verification (`verify-extensions.ts`) re-hashes exactly these two files, so anything that
 * writes `manifest_hash` / `entry_hash` must measure them the same way — a registry's `entryHash`
 * is a claim about the entry file, never about the tarball it arrives in.
 */
export interface ExtensionPackageHashes {
  manifestHash: string;
  entryHash: string;
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Hashes the manifest and entry file of the package rooted at `dir`; throws `package_hash_unreadable`. */
export function computeExtensionPackageHashes(dir: string): ExtensionPackageHashes {
  const manifestPath = resolveExtensionManifestPath(dir);
  if (manifestPath === undefined) {
    throw new Error("package_hash_unreadable: manifest missing");
  }
  try {
    const manifestBytes = readFileSync(manifestPath);
    const manifest = parseExtensionManifestJson(manifestBytes.toString("utf8"));
    const entryRel = extensionEntryRelPath(manifest);
    const absRoot = resolve(dir);
    const absEntry = resolve(join(dir, entryRel));
    const rel = relative(absRoot, absEntry);
    if (rel === "" || rel === ".." || rel.split(sep).includes("..")) {
      throw new Error("entry escapes the package directory");
    }
    return { manifestHash: sha256Hex(manifestBytes), entryHash: sha256Hex(readFileSync(absEntry)) };
  } catch (e) {
    throw new Error(`package_hash_unreadable: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Measures the package at `dir` and refuses (`package_hash_mismatch`) unless both files match the
 * registry's claims. Returns the MEASURED hashes, which are what a caller should store.
 */
export function assertPackageMatchesClaims(
  dir: string,
  claims: ExtensionPackageHashes,
): ExtensionPackageHashes {
  const actual = computeExtensionPackageHashes(dir);
  if (!sha256HexEqualConstantTime(actual.manifestHash, claims.manifestHash.toLowerCase())) {
    throw new Error("package_hash_mismatch: manifest");
  }
  if (!sha256HexEqualConstantTime(actual.entryHash, claims.entryHash.toLowerCase())) {
    throw new Error("package_hash_mismatch: entry");
  }
  return actual;
}
