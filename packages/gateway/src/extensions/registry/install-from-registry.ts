/**
 * Install an extension from a registry (spec § 8.6). Registry bytes become installed code here, so
 * the order is the point: every hash and the publisher signature are checked BEFORE anything is
 * extracted, the Vault is consulted BEFORE the owner is asked, and the owner is asked (inside
 * `installExtensionFromLocalDirectory`) BEFORE a byte lands in the install tree.
 */
import type { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  publisherKeyFingerprint,
  type RegistryChannel,
  RegistryError,
  type RegistryVersionEntry,
} from "@nimbus-dev/registry-format";
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
} from "../install-from-local.ts";
import {
  type ExtensionManifest,
  extensionEntryRelPath,
  resolveExtensionManifestPath,
} from "../manifest.ts";
import { extractPackage } from "../package-extract.ts";
import { isStrictlyInside } from "../path-containment.ts";
import {
  type KeyChange,
  type KeyVia,
  keyChangeNote,
  publisherKeyConflict,
  publisherKeyDecision,
} from "../trust/publisher-key-decision.ts";
import {
  assertNotBlocked,
  type BlockSubject,
  blocksFor,
  TrustBlockError,
} from "../trust/trust-blocks.ts";
import { decodeBase64 } from "../verify-signature.ts";
import { fetchRegistryBytes, type RegistryFetchDeps } from "./registry-fetch.ts";
import {
  fetchRegistryManifest,
  registryHashMismatch,
  sha256Hex,
  verifyRegistryManifestSignature,
} from "./registry-manifest.ts";
import { resolveRegistryEntry } from "./registry-resolve.ts";
import { type RegistryRow, setExtensionSource } from "./registry-store.ts";

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
  /** `--accept-publisher-key`: the exact fingerprint of a new key nothing else vouches for. */
  acceptPublisherKey?: string;
}

/** `--version` is exact; otherwise the semver-newest on `stable`, or on stable and beta for `--channel beta`. */
/**
 * The version to install. An explicit `--version` is taken as asked (and refused later if blocked);
 * otherwise the newest on the channel that nothing blocks (I48), so a taken-down 1.1.0 does not
 * hide a clean 1.0.9. When every candidate is blocked the newest is returned, and the block check
 * that follows refuses it with the reason.
 */
function selectVersion(
  id: string,
  versions: Readonly<Record<string, RegistryVersionEntry>>,
  req: InstallFromRegistryRequest,
  isBlocked: (version: string) => boolean,
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
  const candidates = Object.entries(versions)
    .filter(([, v]) => wanted.includes(v.channel))
    .sort(([a], [b]) => Bun.semver.order(b, a));
  const newest = candidates.find(([v]) => !isBlocked(v)) ?? candidates[0];
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

/**
 * A registry package that has been fetched and fully verified, and staged under `intoDir`, but not
 * installed. `reg` is the `RegistryRow` the fetch resolved (the built-in one included), so a later
 * fetch can reuse it. `publisherKey` is the base64 key the signed index lists; the manifest declares
 * the same one.
 */
export interface VerifiedRegistryPackage {
  readonly id: string;
  readonly version: string;
  /** The extracted package root, inside the `intoDir` it was staged into. */
  readonly sourceRoot: string;
  readonly manifest: ExtensionManifest;
  readonly publisherKey: string;
  /** The entry-file hash the signed index lists, and the staged entry file matched. */
  readonly entryHash: string;
  readonly reg: RegistryRow;
  readonly rootFingerprint: string;
  /** A move from the publisher's trusted keys to this one, and what vouched for it; else null. */
  readonly publisherChange: { readonly change: KeyChange; readonly via: KeyVia } | null;
}

/** `intoDir` must be absent or an empty directory: a staged package is never merged into another tree. */
function assertEmptyStagingDir(intoDir: string): void {
  if (existsSync(intoDir) && readdirSync(intoDir).length > 0) {
    throw new RegistryError(
      "ERR_REGISTRY_EXTRACT_FAILED",
      `the staging directory ${intoDir} is not empty; refusing to merge a package into it`,
    );
  }
  mkdirSync(intoDir, { recursive: true });
}

/**
 * Spec § 8.6 steps 1-5 for an install: resolve the entry, fetch the signed index's manifest and
 * package, check every hash and the I16 publisher signature, check the Vault's cached publisher key,
 * and extract the package into `intoDir`. Nothing is installed: no `extension` row, no publisher key
 * written to the Vault, no install audit row, no approval prompt.
 *
 * It is NOT write-free. Resolving the entry fetches the signed index, which advances the registry's
 * anti-rollback sequence (`registry` row) and appends the registry egress ledger rows for every
 * index, manifest and package request. Those belong to fetching and stay here. The only other
 * write is the staged tree under `intoDir`.
 *
 * `intoDir` is the caller's: it must be absent or an empty directory (otherwise this throws
 * `ERR_REGISTRY_EXTRACT_FAILED` before fetching anything). The archive and the extracted tree are
 * written inside it; on any failure they are removed again. On success the caller owns the staged
 * tree and removes it.
 */
export async function fetchVerifiedRegistryPackage(
  deps: InstallFromRegistryDeps,
  req: InstallFromRegistryRequest,
  intoDir: string,
): Promise<VerifiedRegistryPackage> {
  // An installed id is refused before anything is fetched, whichever registry carries it.
  if (listExtensions(deps.db).some((r) => r.id === req.id)) {
    throw new RegistryError(
      "ERR_REGISTRY_ALREADY_INSTALLED",
      `${req.id} is already installed; use \`nimbus extension update ${req.id}\`, or remove it first`,
    );
  }
  assertEmptyStagingDir(intoDir);
  const fetchDeps: RegistryFetchDeps = { ...deps.fetch, db: deps.db };
  const { reg, entry } = await resolveRegistryEntry(fetchDeps, req.id, req.registry);
  const rootFingerprint = publisherKeyFingerprint(reg.rootKey);
  // I48: refused BEFORE any manifest or package request, and before the owner is asked anything.
  const subjectAt = (version: string): BlockSubject => ({
    extensionId: req.id,
    version,
    publisherId: entry.publisher.id,
    keyFingerprint: publisherKeyFingerprint(entry.publisher.key),
    source: { registry: reg.name, rootFingerprint },
  });
  const [version, vEntry] = selectVersion(
    req.id,
    entry.versions,
    req,
    (v) => blocksFor(deps.db, subjectAt(v)).length > 0,
  );
  assertNotBlocked(deps.db, subjectAt(version));

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
  const { manifest } = fetched;
  await verifyRegistryManifestSignature(fetched, req.id, version);

  // A key the Vault does not trust yet is accepted only along the publisher's rotation chain, when
  // Nimbus vouches for it, or when the owner named its exact fingerprint (spec R5).
  const decision = await publisherKeyDecision(deps, {
    publisherId: entry.publisher.id,
    key: entry.publisher.key,
    source: { registry: reg.name, rootFingerprint },
    ...(req.acceptPublisherKey === undefined ? {} : { acceptFingerprint: req.acceptPublisherKey }),
  });
  if (!decision.ok) throw publisherKeyConflict(entry.publisher.id, decision);

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
    if (
      !isStrictlyInside(sourceRoot, entryPath) ||
      !existsSync(entryPath) ||
      !sha256HexEqualConstantTime(sha256Hex(readFileSync(entryPath)), vEntry.entryHash)
    ) {
      throw registryHashMismatch("entry file", req.id, version);
    }
    return {
      id: req.id,
      version,
      sourceRoot,
      manifest,
      publisherKey: entry.publisher.key,
      entryHash: vEntry.entryHash,
      reg,
      rootFingerprint,
      publisherChange:
        decision.change === null ? null : { change: decision.change, via: decision.via },
    };
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
 * Installs a package `fetchVerifiedRegistryPackage` already verified: the Vault is already checked,
 * the owner is asked (inside `installExtensionFromLocalDirectory`) before a byte lands in the install
 * tree, and the `extension` row, the Vault publisher key and the install audit row are written here
 * and nowhere else. `channel` is the one the owner ASKED for (spec § 8.1), not the resolved
 * version's: a `--channel beta` install that resolved to a stable version keeps tracking beta.
 * The staged tree under `pkg.sourceRoot` is left for the caller to remove.
 */
/** The approver, showing a publisher key change (fingerprints, and what vouched for it) when there is one. */
function withKeyChange(
  approve: ExtensionInstallApprover,
  pc: VerifiedRegistryPackage["publisherChange"],
): ExtensionInstallApprover {
  if (pc === null) return approve;
  return (request) =>
    approve({
      ...request,
      publisherChange: { ...pc.change, via: pc.via },
      publisherChangeNote: keyChangeNote(pc.change, pc.via),
    });
}

export async function installVerifiedRegistryPackage(
  deps: InstallFromRegistryDeps,
  pkg: VerifiedRegistryPackage,
  channel: RegistryChannel,
): Promise<RegistryInstallResult> {
  const { id, version, reg, rootFingerprint } = pkg;
  const publisher = pkg.manifest.publisher;
  if (publisher === undefined) {
    throw new RegistryError(
      "ERR_REGISTRY_MANIFEST_MISMATCH",
      `the verified manifest of ${id}@${version} names no publisher`,
    );
  }
  let installed: InstallExtensionFromLocalResult;
  try {
    installed = await installExtensionFromLocalDirectory({
      db: deps.db,
      extensionsDir: deps.extensionsDir,
      sourcePath: pkg.sourceRoot,
      displaySourcePath: `registry ${reg.name}: ${id}@${version}`,
      vault: deps.vault,
      publisherKey: decodeBase64(pkg.publisherKey),
      sourceRegistry: reg.name,
      rootFingerprint,
      approve: withKeyChange(deps.approve, pkg.publisherChange),
    });
  } catch (e) {
    if (
      e instanceof RegistryError ||
      e instanceof ExtensionInstallNotApprovedError ||
      e instanceof TrustBlockError
    ) {
      throw e;
    }
    throw new RegistryError(
      "ERR_REGISTRY_INSTALL_REFUSED",
      e instanceof Error ? e.message : String(e),
    );
  }
  if (!sha256HexEqualConstantTime(installed.entryHash, pkg.entryHash)) {
    // Installed bytes disagree with the signed index: undo the install rather than keep it.
    clearDeps(deps.db, installed.id);
    deleteExtensionById(deps.db, installed.id);
    rmSync(installed.installPath, { recursive: true, force: true });
    throw registryHashMismatch("entry file", id, version);
  }
  setExtensionSource(deps.db, installed.id, { registry: reg.name, rootFingerprint, channel });
  return {
    ...installed,
    sourceRegistry: reg.name,
    rootFingerprint,
    publisher: { id: publisher.id, fingerprint: publisherKeyFingerprint(pkg.publisherKey) },
  };
}

export async function installFromRegistry(
  deps: InstallFromRegistryDeps,
  req: InstallFromRegistryRequest,
): Promise<RegistryInstallResult> {
  const tmp = mkdtempSync(join(tmpdir(), "nimbus-reg-"));
  try {
    const pkg = await fetchVerifiedRegistryPackage(deps, req, tmp);
    return await installVerifiedRegistryPackage(deps, pkg, req.channel ?? "stable");
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort: the extension is already committed (or the install refused) */
    }
  }
}
