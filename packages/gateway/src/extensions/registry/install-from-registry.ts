/**
 * Install an extension from a registry (spec § 8.6). Registry bytes become installed code here, so
 * the order is the point: every hash and the publisher signature are checked BEFORE anything is
 * extracted, the Vault is consulted BEFORE the owner is asked, and the owner is asked (inside
 * `installExtensionFromLocalDirectory`) BEFORE a byte lands in the install tree.
 */
import type { Database } from "bun:sqlite";
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
import { extensionEntryRelPath, resolveExtensionManifestPath } from "../manifest.ts";
import { extractPackage } from "../package-extract.ts";
import type { RegistryChannel, RegistryVersionEntry } from "./index-format.ts";
import { RegistryError } from "./registry-errors.ts";
import { fetchRegistryBytes, type RegistryFetchDeps } from "./registry-fetch.ts";
import {
  fetchRegistryManifest,
  registryHashMismatch,
  sha256Hex,
  vaultPublisherKeyConflicts,
  verifyRegistryManifestSignature,
} from "./registry-manifest.ts";
import { resolveRegistryEntry } from "./registry-resolve.ts";
import { setExtensionSource } from "./registry-store.ts";

export { MAX_REGISTRY_MANIFEST_BYTES } from "./registry-manifest.ts";

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

  const fetched = await fetchRegistryManifest(fetchDeps, reg, entry, req.id, version, vEntry);
  const packageBytes = await fetchRegistryBytes(fetchDeps, reg, vEntry.package, {
    method: "registry.package",
    extensionId: req.id,
    version,
    maxBytes: MAX_TARBALL_BYTES,
  });
  // Hashes first: nothing is verified or extracted from bytes the index did not sign.
  if (!sha256HexEqualConstantTime(sha256Hex(packageBytes), vEntry.packageSha256)) {
    throw registryHashMismatch("package", req.id, version);
  }
  const { manifest, publisherKey } = fetched;
  await verifyRegistryManifestSignature(fetched, req.id, version);

  if (await vaultPublisherKeyConflicts(deps.vault, entry.publisher.id, publisherKey)) {
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
      throw registryHashMismatch("packaged manifest", req.id, version);
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
      throw registryHashMismatch("entry file", req.id, version);
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
      throw registryHashMismatch("entry file", req.id, version);
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
