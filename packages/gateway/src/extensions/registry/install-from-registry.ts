/**
 * Install an extension from a registry (spec § 8.6). Registry bytes become installed code here, so
 * the order is the point: every hash and the publisher signature are checked BEFORE anything is
 * extracted, the Vault is consulted BEFORE the owner is asked, and the owner is asked (inside
 * `installExtensionFromLocalDirectory`) BEFORE a byte lands in the install tree.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import { deleteExtensionById, listExtensions } from "../../automation/extension-store.ts";
import { sha256HexEqualConstantTime } from "../../util/timing-safe-compare.ts";
import type { NimbusVault } from "../../vault/index.ts";
import { MAX_TARBALL_BYTES } from "../auto-update-apply.ts";
import { clearDeps } from "../dependency-store.ts";
import {
  type ExtensionInstallApprover,
  ExtensionInstallNotApprovedError,
  type InstallExtensionFromLocalResult,
  installExtensionFromLocalDirectory,
  publisherKeyFingerprint,
} from "../install-from-local.ts";
import {
  extensionEntryRelPath,
  parseExtensionManifestForRegistry,
  resolveExtensionManifestPath,
} from "../manifest.ts";
import { extractPackage } from "../package-extract.ts";
import { readPublisherKey } from "../publisher-keys.ts";
import { decodeBase64, verifyManifestSignature } from "../verify-signature.ts";
import type { RegistryChannel, RegistryVersionEntry } from "./index-format.ts";
import { RegistryError } from "./registry-errors.ts";
import { fetchRegistryBytes, type RegistryFetchDeps } from "./registry-fetch.ts";
import { resolveRegistryEntry } from "./registry-resolve.ts";
import { setExtensionSource } from "./registry-store.ts";

/** A registry manifest is a small JSON document; anything larger is refused. */
export const MAX_REGISTRY_MANIFEST_BYTES = 64 * 1024;

export interface InstallFromRegistryDeps {
  db: Database;
  extensionsDir: string;
  vault: NimbusVault;
  fetch: Omit<RegistryFetchDeps, "db">;
  approve: ExtensionInstallApprover;
}

export interface InstallFromRegistryRequest {
  id: string;
  registry?: string;
  version?: string;
  channel?: RegistryChannel;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashMismatch(what: string, id: string, version: string): RegistryError {
  return new RegistryError(
    "ERR_REGISTRY_HASH_MISMATCH",
    `the ${what} of ${id}@${version} does not match the hash the index signed`,
  );
}

/** `--version` is exact; otherwise the semver-newest on `stable`, or on stable and beta for `--channel beta`. */
function selectVersion(
  id: string,
  versions: Readonly<Record<string, RegistryVersionEntry>>,
  req: InstallFromRegistryRequest,
): [string, RegistryVersionEntry] {
  if (req.version !== undefined) {
    const exact = versions[req.version];
    if (exact === undefined) {
      throw new RegistryError(
        "ERR_REGISTRY_VERSION_NOT_FOUND",
        `"${id}" has no version ${req.version} in this registry`,
      );
    }
    return [req.version, exact];
  }
  const wanted = req.channel === "beta" ? ["stable", "beta"] : ["stable"];
  const newest = Object.entries(versions)
    .filter(([, v]) => wanted.includes(v.channel))
    .sort(([a], [b]) => Bun.semver.order(b, a))[0];
  if (newest === undefined) {
    throw new RegistryError(
      "ERR_REGISTRY_VERSION_NOT_FOUND",
      `"${id}" has no ${wanted.join("/")} version in this registry${
        req.channel === "beta" ? "" : " (pass --channel beta or --version)"
      }`,
    );
  }
  return newest;
}

export type RegistryInstallResult = InstallExtensionFromLocalResult & {
  sourceRegistry: string;
  rootFingerprint: string;
  publisher: { id: string; fingerprint: string };
};

export async function installFromRegistry(
  deps: InstallFromRegistryDeps,
  req: InstallFromRegistryRequest,
): Promise<RegistryInstallResult> {
  // An installed id is refused before anything is fetched, whichever registry carries it.
  if (listExtensions(deps.db).some((r) => r.id === req.id)) {
    throw new RegistryError(
      "ERR_REGISTRY_ALREADY_INSTALLED",
      `${req.id} is already installed; use \`nimbus extension update ${req.id}\`, or remove it first`,
    );
  }
  const fetchDeps: RegistryFetchDeps = { ...deps.fetch, db: deps.db };
  const { reg, entry } = await resolveRegistryEntry(fetchDeps, req.id, req.registry);
  const [version, vEntry] = selectVersion(req.id, entry.versions, req);
  const rootFingerprint = publisherKeyFingerprint(reg.rootKey);

  const manifestBytes = await fetchRegistryBytes(fetchDeps, reg, vEntry.manifest, {
    method: "registry.manifest",
    extensionId: req.id,
    version,
    maxBytes: MAX_REGISTRY_MANIFEST_BYTES,
  });
  const packageBytes = await fetchRegistryBytes(fetchDeps, reg, vEntry.package, {
    method: "registry.package",
    extensionId: req.id,
    version,
    maxBytes: MAX_TARBALL_BYTES,
  });
  // Hashes first: nothing is parsed, verified or extracted from bytes the index did not sign.
  if (!sha256HexEqualConstantTime(sha256Hex(manifestBytes), vEntry.manifestSha256)) {
    throw hashMismatch("manifest", req.id, version);
  }
  if (!sha256HexEqualConstantTime(sha256Hex(packageBytes), vEntry.packageSha256)) {
    throw hashMismatch("package", req.id, version);
  }

  const manifestText = new TextDecoder().decode(manifestBytes);
  let manifest: ReturnType<typeof parseExtensionManifestForRegistry>["manifest"];
  try {
    manifest = parseExtensionManifestForRegistry(manifestText).manifest;
  } catch (e) {
    throw new RegistryError(
      "ERR_REGISTRY_MANIFEST_INVALID",
      `the manifest of ${req.id}@${version} is not valid: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (manifest.id !== req.id || manifest.version !== version) {
    throw new RegistryError(
      "ERR_REGISTRY_MANIFEST_MISMATCH",
      `the manifest declares ${manifest.id}@${manifest.version}, not ${req.id}@${version}`,
    );
  }
  if (
    manifest.publisher === undefined ||
    manifest.publisher.id !== entry.publisher.id ||
    manifest.publisher.key !== entry.publisher.key
  ) {
    throw new RegistryError(
      "ERR_REGISTRY_MANIFEST_MISMATCH",
      `the manifest's publisher differs from the one the index lists for ${req.id}`,
    );
  }
  const publisherKey = decodeBase64(entry.publisher.key);
  try {
    await verifyManifestSignature(
      JSON.parse(manifestText) as Record<string, unknown>,
      publisherKey,
    );
  } catch (e) {
    throw new RegistryError(
      "ERR_REGISTRY_SIGNATURE_INVALID",
      `the manifest signature of ${req.id}@${version} does not verify: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const cached = await readPublisherKey(deps.vault, entry.publisher.id);
  if (cached !== undefined && !Buffer.from(cached).equals(Buffer.from(publisherKey))) {
    throw new RegistryError(
      "ERR_REGISTRY_PUBLISHER_KEY_CONFLICT",
      `the Vault already holds a different key for publisher "${entry.publisher.id}"; refusing to replace it`,
    );
  }

  const tmp = mkdtempSync(join(tmpdir(), "nimbus-reg-"));
  try {
    const archivePath = join(tmp, "package.tgz");
    writeFileSync(archivePath, packageBytes);
    let sourceRoot: string;
    try {
      sourceRoot = (await extractPackage(archivePath, join(tmp, "pkg"))).sourceRoot;
    } catch (e) {
      throw new RegistryError(
        "ERR_REGISTRY_EXTRACT_FAILED",
        `the package of ${req.id}@${version} could not be extracted: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    // The package must carry the very manifest the index signed.
    const inPackage = resolveExtensionManifestPath(sourceRoot);
    if (
      inPackage === undefined ||
      !sha256HexEqualConstantTime(sha256Hex(readFileSync(inPackage)), vEntry.manifestSha256)
    ) {
      throw hashMismatch("packaged manifest", req.id, version);
    }
    // The entry file must be the one the index listed BEFORE the owner is asked anything.
    const entryPath = resolve(sourceRoot, extensionEntryRelPath(manifest));
    const entryRel = relative(resolve(sourceRoot), entryPath);
    if (
      entryRel === "" ||
      entryRel === ".." ||
      entryRel.startsWith(`..${sep}`) ||
      !existsSync(entryPath) ||
      !sha256HexEqualConstantTime(sha256Hex(readFileSync(entryPath)), vEntry.entryHash)
    ) {
      throw hashMismatch("entry file", req.id, version);
    }
    let installed: InstallExtensionFromLocalResult;
    try {
      installed = await installExtensionFromLocalDirectory({
        db: deps.db,
        extensionsDir: deps.extensionsDir,
        sourcePath: sourceRoot,
        displaySourcePath: `registry ${reg.name}: ${req.id}@${version}`,
        vault: deps.vault,
        publisherKey,
        sourceRegistry: reg.name,
        rootFingerprint,
        approve: deps.approve,
      });
    } catch (e) {
      if (e instanceof RegistryError || e instanceof ExtensionInstallNotApprovedError) throw e;
      throw new RegistryError(
        "ERR_REGISTRY_INSTALL_REFUSED",
        e instanceof Error ? e.message : String(e),
      );
    }
    if (!sha256HexEqualConstantTime(installed.entryHash, vEntry.entryHash)) {
      // Installed bytes disagree with the signed index: undo the install rather than keep it.
      clearDeps(deps.db, installed.id);
      deleteExtensionById(deps.db, installed.id);
      rmSync(installed.installPath, { recursive: true, force: true });
      throw hashMismatch("entry file", req.id, version);
    }
    setExtensionSource(deps.db, installed.id, {
      registry: reg.name,
      rootFingerprint,
      // The channel the owner ASKED for (spec § 8.1), not the resolved version's: a `--channel beta`
      // install that resolved to a stable version keeps tracking beta.
      channel: req.channel ?? "stable",
    });
    return {
      ...installed,
      sourceRegistry: reg.name,
      rootFingerprint,
      publisher: {
        id: entry.publisher.id,
        fingerprint: publisherKeyFingerprint(entry.publisher.key),
      },
    };
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort: the extension is already committed (or the install refused) */
    }
  }
}
