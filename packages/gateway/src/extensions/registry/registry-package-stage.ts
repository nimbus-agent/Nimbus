/**
 * Spec § 8.6 step 5, shared by a registry install's root and its dependencies: one ledgered package
 * fetch refused unless its bytes are the ones the index signed, then extraction into a staging
 * directory and the packaged-manifest and entry-file hash checks. Nothing is installed here.
 *
 * Its own module so that the root install (`install-from-registry.ts`) and the dependency resolver
 * (`registry-dependency-fetcher.ts`) can both use it without importing each other.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { RegistryError, type RegistryVersionEntry } from "@nimbus-dev/registry-format";
import { sha256HexEqualConstantTime } from "../../util/timing-safe-compare.ts";
import { MAX_TARBALL_BYTES } from "../auto-update-apply.ts";
import {
  type ExtensionManifest,
  extensionEntryRelPath,
  resolveExtensionManifestPath,
} from "../manifest.ts";
import { extractPackage } from "../package-extract.ts";
import { isStrictlyInside } from "../path-containment.ts";
import { fetchRegistryBytes, type RegistryFetchDeps } from "./registry-fetch.ts";
import { registryHashMismatch, sha256Hex } from "./registry-manifest.ts";
import type { RegistryRow } from "./registry-store.ts";

/** `intoDir` must be absent or an empty directory: a staged package is never merged into another tree. */
export function assertEmptyStagingDir(intoDir: string): void {
  if (existsSync(intoDir) && readdirSync(intoDir).length > 0) {
    throw new RegistryError(
      "ERR_REGISTRY_EXTRACT_FAILED",
      `the staging directory ${intoDir} is not empty; refusing to merge a package into it`,
    );
  }
  mkdirSync(intoDir, { recursive: true });
}

/** One ledgered `registry.package` fetch, refused unless its bytes are the ones the index signed. */
export async function fetchHashedPackage(
  fetchDeps: RegistryFetchDeps,
  reg: RegistryRow,
  id: string,
  version: string,
  vEntry: RegistryVersionEntry,
): Promise<Uint8Array> {
  const packageBytes = await fetchRegistryBytes(fetchDeps, reg, vEntry.package, {
    method: "registry.package",
    extensionId: id,
    version,
    maxBytes: MAX_TARBALL_BYTES,
  });
  if (!sha256HexEqualConstantTime(sha256Hex(packageBytes), vEntry.packageSha256)) {
    throw registryHashMismatch("package", id, version);
  }
  return packageBytes;
}

/**
 * Extracts hash-checked package bytes into `intoDir` and checks the extracted tree against the
 * index: the packaged manifest is the very one the index signed, and the entry file is the one it
 * listed. On any failure the archive and the extracted tree are removed again.
 */
export async function extractVerifiedPackage(
  packageBytes: Uint8Array,
  id: string,
  version: string,
  vEntry: RegistryVersionEntry,
  manifest: ExtensionManifest,
  intoDir: string,
): Promise<{ sourceRoot: string }> {
  const archivePath = join(intoDir, "package.tgz");
  const extractDir = join(intoDir, "pkg");
  try {
    writeFileSync(archivePath, packageBytes);
    let sourceRoot: string;
    try {
      sourceRoot = (await extractPackage(archivePath, extractDir)).sourceRoot;
    } catch (e) {
      throw new RegistryError(
        "ERR_REGISTRY_EXTRACT_FAILED",
        `the package of ${id}@${version} could not be extracted: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    // The package must carry the very manifest the index signed.
    const inPackage = resolveExtensionManifestPath(sourceRoot);
    if (
      inPackage === undefined ||
      !sha256HexEqualConstantTime(sha256Hex(readFileSync(inPackage)), vEntry.manifestSha256)
    ) {
      throw registryHashMismatch("packaged manifest", id, version);
    }
    // The entry file must be the one the index listed BEFORE the owner is asked anything.
    const entryPath = resolve(sourceRoot, extensionEntryRelPath(manifest));
    if (
      !isStrictlyInside(sourceRoot, entryPath) ||
      !existsSync(entryPath) ||
      !sha256HexEqualConstantTime(sha256Hex(readFileSync(entryPath)), vEntry.entryHash)
    ) {
      throw registryHashMismatch("entry file", id, version);
    }
    return { sourceRoot };
  } catch (e) {
    try {
      rmSync(archivePath, { force: true });
      rmSync(extractDir, { recursive: true, force: true });
    } catch {
      /* best-effort: the original refusal is the error that matters */
    }
    throw e;
  }
}

/**
 * Spec § 8.6 step 5 for a package whose `manifest` is ALREADY hash-checked and I16-verified
 * against `vEntry` (a dependency verified in phase 1): one ledgered package fetch, its
 * `packageSha256`, extraction into `intoDir` (absent or empty), the packaged-manifest hash and the
 * entry hash. Nothing is installed. The root install runs the same two halves with its own
 * signature and Vault checks between them, so a root and a dependency are staged by the same code.
 */
export async function stageVerifiedPackage(
  fetchDeps: RegistryFetchDeps,
  reg: RegistryRow,
  id: string,
  version: string,
  vEntry: RegistryVersionEntry,
  manifest: ExtensionManifest,
  intoDir: string,
): Promise<{ sourceRoot: string }> {
  assertEmptyStagingDir(intoDir);
  const packageBytes = await fetchHashedPackage(fetchDeps, reg, id, version, vEntry);
  return extractVerifiedPackage(packageBytes, id, version, vEntry, manifest, intoDir);
}
