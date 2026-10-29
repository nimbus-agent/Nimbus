import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  cpSync,
  type Dirent,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import {
  assertSafeExtensionId,
  isStarterPack,
  publisherKeyFingerprint,
  type RegistryChannel,
  RegistryError,
  type VersionProvenance,
} from "@nimbus-dev/registry-format";
import type { Logger } from "pino";

import {
  deleteExtensionById,
  type ExtensionRow,
  insertExtensionRow,
  isInstalledAsDependency,
  listExtensions,
  setExtensionPublisherKeyFingerprint,
  setInstalledAsDependency,
} from "../automation/extension-store.ts";
import { appendAuditEntry } from "../db/audit-chain.ts";
import { readIndexedUserVersion } from "../index/migrations/runner.ts";
import { sha256HexEqualConstantTime } from "../util/timing-safe-compare.ts";
import type { NimbusVault } from "../vault/index.ts";
import {
  type ConnectorRequirementDeps,
  type ConnectorRequirementStatus,
  type ConnectorRequirementStatusesFn,
  connectorRequirementStatuses,
} from "./connector-requirements.ts";
import type { ContinuityEntry } from "./continuity/continuity-table.ts";
import { resolveClosure } from "./dependency-graph.ts";
import { clearDeps, recordInstall } from "./dependency-store.ts";
import {
  type ExtensionManifestForSolver,
  type InstalledForSolver,
  type RegistryFetcher,
  type ResolvedNode,
  registryNameOf,
  type SourceKey,
  sourceKey,
} from "./dependency-types.ts";
import {
  type PlannedPackage,
  planPermissionsUnion,
  renderInstallPlan,
  withNeedsBlock,
} from "./install-plan-text.ts";
import {
  EXTENSION_MANIFEST_FILENAME,
  type ExtensionManifest,
  extensionEntryRelPath,
  parseExtensionManifestForRegistry,
  parseExtensionManifestJson,
  resolveExtensionManifestPath,
} from "./manifest.ts";
import { rangesOf } from "./manifest-support.ts";
import { extractPackage } from "./package-extract.ts";
import { resolvePublisherKey, writePublisherKeyFor } from "./publisher-keys.ts";
import type {
  RegistryDependencyResolver,
  StagedDependency,
} from "./registry/registry-dependency-fetcher.ts";
import { registryHashMismatch } from "./registry/registry-manifest.ts";
import { getExtensionSource, getRegistry, setExtensionSource } from "./registry/registry-store.ts";
import { computeExtensionTreeDigest } from "./tree-digest.ts";
import { keyChangeNote } from "./trust/publisher-key-decision.ts";
import { assertNotBlocked } from "./trust/trust-blocks.ts";
import {
  publisherBadgeText,
  type VerifiedPublisher,
  verifiedPublisherFor,
} from "./trust/verified-publisher.ts";
import { decodeBase64, verifyManifestSignature } from "./verify-signature.ts";

export type { PlannedPackage } from "./install-plan-text.ts";

/**
 * The plan installer stages a registry plan's dependencies under `<root>/<prefix>XXXXXX`, where
 * `<root>` is `planStagingRoot` (default `tmpdir()`).
 */
const PLAN_STAGING_PREFIX = "nimbus-plan-";

function sha256HexOfBytes(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function extensionInstallDirectory(extensionsDir: string, extensionId: string): string {
  assertSafeExtensionId(extensionId);
  const normalized = extensionId.replaceAll("\\", "/");
  const parts = normalized.split("/").filter((p) => p !== "" && p !== ".");
  return join(extensionsDir, ...parts);
}

async function verifyAndRecordSignature(
  options: {
    db: Database;
    manifest: ExtensionManifest;
    vault?: NimbusVault;
    publisherKeyPath?: string;
    publisherKey?: Uint8Array;
  },
  destManifest: ExtensionManifest,
  destManifestText: string,
): Promise<string | null> {
  if (destManifest.publisher === undefined) return null;
  if (options.vault === undefined) {
    throw new Error("signed-extension install requires the vault to be wired");
  }
  const publisherId = destManifest.publisher.id;
  const rawManifestObj = JSON.parse(destManifestText) as Record<string, unknown>;
  const vault = options.vault;
  let verifiedFingerprint: string | null = null;
  try {
    // A key passed explicitly (a registry install: the signed index named it) replaces the
    // path/Vault resolution entirely, but must still be the key the manifest declares. A local
    // install never fetches a key: `--publisher-key`, else the Vault's cached key, else refused.
    let resolvedPubkey: Uint8Array;
    if (options.publisherKey === undefined) {
      resolvedPubkey = await resolvePublisherKey({
        publisherId,
        explicitKeyPath: options.publisherKeyPath,
        vault,
        declaredKey: destManifest.publisher.key,
      });
    } else {
      resolvedPubkey = options.publisherKey;
      const declared = Buffer.from(destManifest.publisher.key, "base64");
      if (!Buffer.from(resolvedPubkey).equals(declared)) {
        throw new Error("manifest publisher key differs from the key supplied for this install");
      }
    }
    await verifyManifestSignature(rawManifestObj, resolvedPubkey);
    verifiedFingerprint = await writePublisherKeyFor(vault, publisherId, resolvedPubkey);
    appendAuditEntry(options.db, {
      actionType: "extension.signature_verified",
      hitlStatus: "not_required",
      actionJson: JSON.stringify({
        id: options.manifest.id,
        publisher_id: publisherId,
        verified_at_ms: Date.now(),
      }),
      timestamp: Date.now(),
    });
  } catch (err) {
    appendAuditEntry(options.db, {
      actionType: "extension.signature_failed",
      hitlStatus: "not_required",
      actionJson: JSON.stringify({
        id: options.manifest.id,
        publisher_id: publisherId,
        error: err instanceof Error ? err.name : "Unknown",
        message: err instanceof Error ? err.message : String(err),
      }),
      timestamp: Date.now(),
    });
    throw err;
  }
  return verifiedFingerprint;
}

async function completeExtensionInstallAfterCopy(options: {
  db: Database;
  dest: string;
  manifest: ExtensionManifest;
  vault?: NimbusVault;
  publisherKeyPath?: string;
  publisherKey?: Uint8Array;
  /** Called once the row's transaction has committed, so a rollback knows the row exists. */
  onRowCommitted?: () => void;
}): Promise<SingleInstallResult> {
  const destManifestPath = resolveExtensionManifestPath(options.dest);
  if (destManifestPath === undefined) {
    throw new Error("extension manifest missing after copy");
  }
  const destManifestBytes = readFileSync(destManifestPath);
  const manifestHex = sha256HexOfBytes(destManifestBytes);
  const destManifestText = destManifestBytes.toString("utf8");
  const { manifest: destManifest } = parseExtensionManifestForRegistry(destManifestText);
  if (
    destManifest.id !== options.manifest.id ||
    destManifest.version !== options.manifest.version
  ) {
    throw new Error("manifest id/version changed across copy");
  }

  const verifiedKeyFingerprint =
    destManifest.publisher === undefined
      ? null
      : await verifyAndRecordSignature(options, destManifest, destManifestText);

  const entryRelRaw = extensionEntryRelPath(destManifest);
  if (entryRelRaw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(entryRelRaw)) {
    throw new Error("extension entry must be a relative path");
  }
  const entryPath = assertEntryInsideInstall(options.dest, entryRelRaw);
  if (!existsSync(entryPath)) {
    throw new Error(`extension entry file missing: ${entryRelRaw}`);
  }
  const entryBytes = readFileSync(entryPath);
  const entryHex = sha256HexOfBytes(entryBytes);
  const treeDigest = computeExtensionTreeDigest(options.dest);

  const now = Date.now();
  // One transaction: a signed row never exists without the key that verified it.
  options.db.transaction(() => {
    insertExtensionRow(options.db, {
      id: options.manifest.id,
      version: options.manifest.version,
      install_path: options.dest,
      manifest_hash: manifestHex,
      entry_hash: entryHex,
      tree_digest: treeDigest,
      // From the manifest just verified at the destination, never the caller's copy.
      kind: isStarterPack(destManifest) ? "starter-pack" : "extension",
      enabled: 1,
      installed_at: now,
      last_verified_at: now,
    });
    if (verifiedKeyFingerprint !== null && readIndexedUserVersion(options.db) >= 76) {
      setExtensionPublisherKeyFingerprint(options.db, options.manifest.id, verifiedKeyFingerprint);
    }
  })();
  options.onRowCommitted?.();

  return {
    id: options.manifest.id,
    version: options.manifest.version,
    installPath: options.dest,
    manifestHash: manifestHex,
    entryHash: entryHex,
    treeDigest,
  };
}

function scanForSymlinks(root: string): void {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) continue;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        throw new Error(`extension source contains a symlink: ${full}`);
      }
      if (st.isDirectory()) {
        stack.push(full);
      }
    }
  }
}

async function installExtensionFromArchive(options: {
  db: Database;
  extensionsDir: string;
  archivePath: string;
  vault?: NimbusVault;
  continuityTable?: readonly ContinuityEntry[];
  publisherKeyPath?: string;
  publisherKey?: Uint8Array;
  sourceRegistry?: string;
  rootFingerprint?: string;
  approve?: ExtensionInstallApprover;
}): Promise<InstallExtensionFromLocalResult | PromotedInstallResult> {
  const tmp = mkdtempSync(join(tmpdir(), "nimbus-ext-tgz-"));
  try {
    const { sourceRoot: root } = await extractPackage(options.archivePath, tmp);
    return await installExtensionFromLocalDirectory({
      db: options.db,
      extensionsDir: options.extensionsDir,
      sourcePath: root,
      ...(options.vault !== undefined && { vault: options.vault }),
      ...(options.continuityTable !== undefined && { continuityTable: options.continuityTable }),
      ...(options.publisherKeyPath !== undefined && {
        publisherKeyPath: options.publisherKeyPath,
      }),
      ...(options.publisherKey !== undefined && { publisherKey: options.publisherKey }),
      ...(options.sourceRegistry !== undefined && { sourceRegistry: options.sourceRegistry }),
      ...(options.rootFingerprint !== undefined && { rootFingerprint: options.rootFingerprint }),
      ...(options.approve !== undefined && { approve: options.approve }),
      displaySourcePath: options.archivePath,
    });
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

function assertEntryInsideInstall(installRoot: string, entryRel: string): string {
  const absRoot = resolve(installRoot);
  const absEntry = resolve(join(installRoot, entryRel));
  const rel = relative(absRoot, absEntry);
  if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || rel.split(sep).includes("..")) {
    throw new Error("extension entry path escapes install directory");
  }
  return absEntry;
}

type SingleInstallResult = {
  id: string;
  version: string;
  installPath: string;
  manifestHash: string;
  entryHash: string;
  treeDigest: string;
};

/**
 * What the local owner approves before an install writes anything (Non-Negotiable 2: the consent
 * gate lives in the executor, never in a client prompt). Built from the RESOLVED plan, so the owner
 * sees every package the install will add — dependencies included — and nothing is copied, fetched
 * or rowed for a plan they did not approve.
 *
 * `publisher` is what the manifest CLAIMS. The I16 signature is verified after approval, against
 * the copied bytes, and a failure there still rolls the whole install back — so approval never
 * substitutes for verification, it only precedes it.
 */
export type ExtensionInstallApprovalRequest = {
  readonly id: string;
  readonly version: string;
  readonly sourcePath: string;
  /**
   * `fingerprint` is the first 32 hex chars of SHA-256 over the decoded Ed25519 public key. It is
   * deliberately NOT named `key`: the consent display redacts any payload field whose name
   * contains "key" (`executor.ts` `SENSITIVE_PAYLOAD_KEY`), which would hide the one value that
   * lets the owner tell two publishers with the same id apart.
   */
  readonly publisher: { readonly id: string; readonly fingerprint: string } | null;
  readonly permissions: ExtensionManifest["permissions"];
  /** Packages this install adds, root first, then each newly installed dependency. */
  readonly installs: ReadonlyArray<{ readonly id: string; readonly version: string }>;
  /**
   * Set only for a registry install: the registry's name and its pinned root-key fingerprint.
   * Named `rootFingerprint`, never `*Key`, for the same redaction reason as `publisher.fingerprint`.
   */
  readonly sourceRegistry?: string;
  readonly rootFingerprint?: string;
  /**
   * Set when the publisher's key differs from every key the Vault trusts (marketplace trust layer,
   * rotation): fingerprints only, and what vouched for the change. Never `*Key`-named (redaction).
   */
  readonly publisherChange?: {
    readonly from: readonly string[];
    readonly to: string;
    readonly via: string;
  };
  readonly publisherChangeNote?: string;
  /**
   * R6: whether the current Nimbus verification lists the publisher's key — computed only for a
   * manifest whose signature verifies with the key it declares, so a forged manifest claiming a
   * verified publisher's key is shown as unverified. `publisherBadge` is the one sentence to show.
   */
  readonly verifiedPublisher?: VerifiedPublisher | null;
  readonly publisherBadge?: string;
  /**
   * A registry install only: the build provenance the registry verified for this version (trust
   * layer PR 4c), and the one sentence to show; absent when there is none.
   */
  readonly provenance?: VersionProvenance;
  readonly provenanceNote?: string;
  /**
   * Set only when the install adds or reuses more than one package (or a package from another
   * registry than the root's): every plan node, in install (topological) order. A single-package
   * install's request carries none of these three, exactly as before.
   */
  readonly plan?: readonly PlannedPackage[];
  /** The permissions of every newly installed package together, sorted and deduplicated. */
  readonly planPermissions?: ExtensionManifest["permissions"];
  /**
   * The prompt body the executor prints after Details (`withNeedsBlock`): the rendered plan
   * when there is one, then a `Needs:` block when an added package requires a connector. Absent
   * when there is neither.
   */
  readonly planText?: string;
  /**
   * Whether each connector the root and every newly installed dependency require is connected,
   * computed before the owner is asked (nothing is installed yet). Set on every install the gateway
   * has a Vault for (`[]` when nothing is required); absent without one. Install never waits on it.
   */
  readonly connectorRequirements?: readonly ConnectorRequirementStatus[];
};

/** Resolves `true` only when the local owner approved; anything else installs nothing. */
export type ExtensionInstallApprover = (
  request: ExtensionInstallApprovalRequest,
) => Promise<boolean>;

export type InstallExtensionFromLocalResult = SingleInstallResult & {
  installed: readonly ResolvedNode[];
};

/**
 * An explicit install of a package that is already installed only as a dependency (V78
 * `installed_as_dependency = 1`): nothing is fetched, copied or approved, and the only write is the
 * marker, cleared so a later removal of what needed it no longer offers to remove this one.
 */
export type PromotedInstallResult = {
  readonly id: string;
  readonly version: string;
  readonly promoted: true;
  /** The registry and channel the kept copy was installed from; absent for a local copy. */
  readonly sourceRegistry?: string;
  readonly channel?: "stable" | "beta";
};

export function isPromotedInstall<T extends object>(
  r: T | PromotedInstallResult,
): r is PromotedInstallResult {
  return "promoted" in r && r.promoted === true;
}

/** The kind recorded for an installed package; "extension" when the row is absent or predates V79. */
export function installedKindOf(db: Database, id: string): "extension" | "starter-pack" {
  return listExtensions(db).find((r) => r.id === id)?.kind === "starter-pack"
    ? "starter-pack"
    : "extension";
}

/**
 * The installed row an explicit install may promote, or `undefined` when there is nothing to
 * promote (not installed, or installed explicitly): the caller then refuses exactly as before.
 */
export function installedDependencyRow(db: Database, id: string): ExtensionRow | undefined {
  const row = listExtensions(db).find((r) => r.id === id);
  return row !== undefined && isInstalledAsDependency(db, id) ? row : undefined;
}

/** Clears the dependency marker on `row`. The marker only decides what a later removal offers, so it needs no consent. */
export function promoteInstalledDependency(db: Database, row: ExtensionRow): PromotedInstallResult {
  setInstalledAsDependency(db, row.id, false);
  const source = getExtensionSource(db, row.id);
  return {
    id: row.id,
    version: row.version,
    promoted: true,
    ...(source === undefined ? {} : { sourceRegistry: source.registry, channel: source.channel }),
  };
}

/**
 * A local install promotes an installed dependency only when the folder holds the SAME package: the
 * same id, version and manifest bytes (`manifest_hash`). A different package that reuses the id is
 * not taken as the owner keeping the installed one: it is refused as already installed, before any
 * approval (see {@link assertNotAlreadyInstalledLocally}), and the marker stays. The plain local
 * install only: a registry-driven call has already refused an installed id before fetching.
 */
function promotableLocalDependency(
  options: InstallFromLocalOptions,
  manifest: ExtensionManifest,
  manifestBytes: Buffer,
): ExtensionRow | undefined {
  if (options.registryPlan !== undefined || options.sourceRegistry !== undefined) return undefined;
  const row = installedDependencyRow(options.db, manifest.id);
  if (row === undefined || row.version !== manifest.version) return undefined;
  return sha256HexEqualConstantTime(row.manifest_hash, sha256HexOfBytes(manifestBytes))
    ? row
    : undefined;
}

/**
 * A plain local install of an id that is already installed, and that did not qualify for promotion,
 * can only end refused (its install directory exists). Refuse it before solving and before the
 * owner is asked, rather than after an approval it could never use.
 */
function assertNotAlreadyInstalledLocally(
  options: InstallFromLocalOptions,
  manifest: ExtensionManifest,
): void {
  if (options.registryPlan !== undefined || options.sourceRegistry !== undefined) return;
  const row = listExtensions(options.db).find((r) => r.id === manifest.id);
  if (row === undefined) return;
  throw new Error(
    `${row.id}@${row.version} is already installed; remove it first (nimbus extension remove ${row.id}) to reinstall it`,
  );
}

/**
 * The solver's view of what is installed: each row's version and recorded source, and each
 * readable installed manifest's ranges as an active constraint.
 */
export function buildSolverInputs(db: Database): {
  installed: ReadonlyMap<string, InstalledForSolver>;
  activeConstraints: ReadonlyMap<string, ReadonlyMap<string, string>>;
} {
  const rows = listExtensions(db);
  const installed = new Map<string, InstalledForSolver>();
  const activeConstraints = new Map<string, ReadonlyMap<string, string>>();
  for (const row of rows) {
    installed.set(row.id, {
      version: row.version,
      source:
        row.source_registry && row.source_root_fingerprint
          ? sourceKey(row.source_registry, row.source_root_fingerprint)
          : null,
    });
    const manifestPath = resolveExtensionManifestPath(row.install_path);
    if (manifestPath === undefined) continue;
    try {
      const raw = readFileSync(manifestPath, "utf8");
      const mf = parseExtensionManifestJson(raw);
      const ranges = rangesOf(mf.dependsOn);
      if (Object.keys(ranges).length > 0) {
        activeConstraints.set(row.id, new Map(Object.entries(ranges)));
      }
    } catch {
      // Unreadable / malformed manifest — skip. The signature-verify startup
      // pass (I16) is the authoritative check; here we just skip gracefully.
    }
  }
  return { installed, activeConstraints };
}

/**
 * The solver's view of what exists: ONLY what is already installed. Nothing is fetched, so a
 * dependency that is not installed is unsatisfiable and the install refuses (spec § 8.6 step 8;
 * transitive fetching is a later project). `targetSource` is always null, so a dependency — an
 * object one naming a registry included — is satisfied by any installed copy.
 */
function buildLocalSolverFetcher(
  db: Database,
  installedMap: ReadonlyMap<string, InstalledForSolver>,
): RegistryFetcher {
  return {
    targetSource: () => null,
    listVersions(id: string): Promise<readonly string[]> {
      const pinned = installedMap.get(id);
      return Promise.resolve(pinned === undefined ? [] : [pinned.version]);
    },
    fetchManifest(id: string, version: string): Promise<ExtensionManifestForSolver> {
      return Promise.try(() => {
        const extRow =
          installedMap.get(id)?.version === version
            ? listExtensions(db).find((r) => r.id === id)
            : undefined;
        const mfPath =
          extRow === undefined ? undefined : resolveExtensionManifestPath(extRow.install_path);
        if (mfPath === undefined) {
          throw new Error(`dependency ${id}@${version} is not installed`);
        }
        const mf = parseExtensionManifestJson(readFileSync(mfPath, "utf8"));
        return {
          id: mf.id,
          version: mf.version,
          ...(mf.dependsOn === undefined ? {} : { dependsOn: mf.dependsOn }),
        };
      });
    },
  };
}

type NodeInstallOptions = {
  db: Database;
  extensionsDir: string;
  vault?: NimbusVault;
  publisherKeyPath?: string;
  publisherKey?: Uint8Array;
};

/**
 * One package the plan installer created: its directory from the moment the copy starts (the
 * destination did not exist, so removing it removes only what this install made), and its id once
 * its `extension` row has committed.
 */
type CreatedPackage = { readonly dir: string; id: string | null };

async function installRootNode(
  options: NodeInstallOptions,
  sourceResolved: string,
  manifest: ExtensionManifest,
  created: CreatedPackage[],
): Promise<SingleInstallResult> {
  const dest = extensionInstallDirectory(options.extensionsDir, manifest.id);
  if (existsSync(dest)) {
    // A directory no extension row owns is what an earlier install left behind (a rollback that
    // could not remove it, or a crash), not an installed extension: say which, so the owner knows
    // removing the directory is safe.
    const owned = listExtensions(options.db).some((r) => resolve(r.install_path) === resolve(dest));
    throw new Error(
      owned
        ? `extension already installed at ${dest}`
        : `a directory from an earlier failed install is in the way at ${dest}; remove it and retry`,
    );
  }

  scanForSymlinks(sourceResolved);
  mkdirSync(options.extensionsDir, { recursive: true });

  const record: CreatedPackage = { dir: dest, id: null };
  created.push(record);
  try {
    cpSync(sourceResolved, dest, { recursive: true, dereference: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`extension copy failed: ${msg}`);
  }

  return await completeExtensionInstallAfterCopy({
    db: options.db,
    dest,
    manifest,
    ...(options.vault !== undefined && { vault: options.vault }),
    ...(options.publisherKeyPath !== undefined && {
      publisherKeyPath: options.publisherKeyPath,
    }),
    ...(options.publisherKey !== undefined && { publisherKey: options.publisherKey }),
    onRowCommitted: () => {
      record.id = manifest.id;
    },
  });
}

/** The rollback steps of a failed plan install that themselves failed (see {@link withRollbackFailures}). */
export type RollbackFailure = {
  readonly step: "clearDeps" | "deleteExtension" | "removeDirectory";
  readonly id: string | null;
  readonly dir: string;
  readonly error: unknown;
};

/** The rollback failures a plan install attached to the error it threw; empty when it attached none. */
export function rollbackFailuresOf(e: unknown): readonly RollbackFailure[] {
  if (typeof e !== "object" || e === null || !("rollbackFailures" in e)) return [];
  const failures: unknown = e.rollbackFailures;
  return Array.isArray(failures) ? (failures as RollbackFailure[]) : [];
}

/**
 * The rollback-incomplete note an install refusal carries to the owner: ` (rollback incomplete:
 * <path or id>, …)` naming what is left behind — the directory a failed `removeDirectory` left, else
 * the id whose row or edges remain — each once, control characters stripped (a path is
 * owner-visible text); `""` when the error carries no rollback failure.
 */
export function rollbackIncompleteNote(e: unknown): string {
  const failures = rollbackFailuresOf(e);
  if (failures.length === 0) return "";
  const left = failures.map((f) =>
    (f.step === "removeDirectory" ? f.dir : (f.id ?? f.dir)).replace(/\p{Cc}/gu, ""),
  );
  return ` (rollback incomplete: ${[...new Set(left)].join(", ")})`;
}

/**
 * Where an install refusal is caught for the owner (an RPC result): a rollback that itself failed
 * is logged as a warning with every failed step, and the returned note (see
 * {@link rollbackIncompleteNote}) is appended to the message the owner sees. `""` (and no log)
 * when the rollback was complete.
 */
export function reportIncompleteRollback(
  logger: Pick<Logger, "warn">,
  installing: string,
  e: unknown,
): string {
  const note = rollbackIncompleteNote(e);
  if (note === "") return note;
  logger.warn(
    {
      installing,
      rollbackFailures: rollbackFailuresOf(e).map((f) => ({
        step: f.step,
        id: f.id,
        dir: f.dir,
        error: f.error instanceof Error ? f.error.message : String(f.error),
      })),
    },
    "extension install refused, and its rollback left packages behind",
  );
  return note;
}

/**
 * Undoes every package this plan created, newest first: its edges, its row (with any run grant,
 * `deleteExtensionById`) and its directory. Packages present before the plan are never touched;
 * audit and egress rows stay. Each step runs on its own, so one failing step never skips the
 * others, and every failure is RETURNED for the caller to report, never swallowed.
 */
function rollbackCreatedPackages(
  db: Database,
  created: readonly CreatedPackage[],
): RollbackFailure[] {
  const failures: RollbackFailure[] = [];
  const attempt = (step: RollbackFailure["step"], pkg: CreatedPackage, run: () => void): void => {
    try {
      run();
    } catch (error) {
      failures.push({ step, id: pkg.id, dir: pkg.dir, error });
    }
  };
  for (const pkg of [...created].reverse()) {
    const id = pkg.id;
    if (id !== null) {
      attempt("clearDeps", pkg, () => clearDeps(db, id));
      attempt("deleteExtension", pkg, () => deleteExtensionById(db, id));
    }
    attempt("removeDirectory", pkg, () => rmSync(pkg.dir, { recursive: true, force: true }));
  }
  return failures;
}

/**
 * The ORIGINAL install failure, still the primary error (same class, code and message), carrying
 * any rollback step that failed: as `rollbackFailures`, and as its `cause` when it has none yet.
 */
function withRollbackFailures(e: unknown, failures: readonly RollbackFailure[]): unknown {
  if (failures.length === 0 || !(e instanceof Error)) return e;
  Object.assign(e, { rollbackFailures: failures });
  if (e.cause === undefined) {
    e.cause = new AggregateError(
      failures.map((f) => f.error),
      `rollback incomplete: ${failures.map((f) => `${f.step} ${f.id ?? f.dir}`).join(", ")}`,
    );
  }
  return e;
}

/** Refused unless the installed entry file is the one the signed index listed (I44). */
function assertInstalledEntryHash(
  installed: SingleInstallResult,
  expected: string | undefined,
): void {
  if (expected === undefined) return;
  if (!sha256HexEqualConstantTime(installed.entryHash, expected)) {
    throw registryHashMismatch("entry file", installed.id, installed.version);
  }
}

/** What the dependency half of the plan installer reads: the install's db, trees, Vault and resolver. */
type PlanInstallContext = Pick<
  InstallFromLocalOptions,
  "db" | "extensionsDir" | "vault" | "registryPlan"
>;

/** Phase 2 of a registry plan: each newly installed dependency's package, staged under `intoDir`. */
async function stageNewDependencies(
  options: PlanInstallContext,
  plan: { nodes: readonly ResolvedNode[] },
  rootId: string,
  intoDir: () => string,
): Promise<ReadonlyMap<string, StagedDependency>> {
  const newDeps = plan.nodes.filter((n) => n.newlyInstalled && n.id !== rootId);
  const [first] = newDeps;
  if (first === undefined) return new Map();
  const hooks = options.registryPlan;
  if (hooks === undefined) {
    // Unreachable through the local-only solver, which never plans an uninstalled package.
    throw new Error(`dependency ${first.id}@${first.version} is not installed; install it first`);
  }
  // Only nodes phase 1 verified: `stage` refuses anything else, an installed copy included.
  const staged = await hooks.resolver.stage(newDeps, intoDir());
  return new Map(staged.map((s) => [s.id, s]));
}

/** Installs one staged dependency as a registry package of the plan's channel. */
async function installStagedDependency(
  options: PlanInstallContext,
  channel: RegistryChannel,
  dep: StagedDependency,
  created: CreatedPackage[],
): Promise<void> {
  // Another install got there while the plan was staged: an install race, refused as the plan's
  // up-front existence check refuses it (never read as a failed signature). The same check in
  // `installRootNode` runs in this tick, so it can no longer be the one that fires.
  if (existsSync(extensionInstallDirectory(options.extensionsDir, dep.id))) {
    throw new RegistryError(
      "ERR_REGISTRY_INSTALL_REFUSED",
      `${dep.id} was installed while this plan was being installed; the plan that would install ${dep.id}@${dep.version} is out of date`,
    );
  }
  const installed = await installRootNode(
    {
      db: options.db,
      extensionsDir: options.extensionsDir,
      ...(options.vault !== undefined && { vault: options.vault }),
      publisherKey: decodeBase64(dep.publisherKey),
    },
    dep.sourceRoot,
    dep.manifest,
    created,
  );
  assertInstalledEntryHash(installed, dep.vEntry.entryHash);
  setExtensionSource(options.db, dep.id, {
    registry: dep.reg.name,
    rootFingerprint: dep.reg.rootFingerprint,
    channel,
  });
  setInstalledAsDependency(options.db, dep.id, true);
}

/**
 * Installs an approved plan all-or-nothing: stage every newly installed dependency (registry plan
 * only), install them in topological order — each through the same copy + I16 path as the root,
 * with its index key and its index entry hash — then the root (checked against
 * `expectedRootEntryHash`), then record every edge and the install audit row. Any failure undoes
 * every package created here; the staging directory is always removed.
 */
async function installApprovedPlan(
  options: InstallFromLocalOptions,
  plan: { nodes: readonly ResolvedNode[] },
  sourceResolved: string,
  manifest: ExtensionManifest,
): Promise<void> {
  const created: CreatedPackage[] = [];
  let stagingDir: string | undefined;
  try {
    const staged = await stageNewDependencies(options, plan, manifest.id, () => {
      stagingDir = mkdtempSync(join(options.planStagingRoot ?? tmpdir(), PLAN_STAGING_PREFIX));
      return stagingDir;
    });
    const channel = options.registryPlan?.channel ?? "stable";
    // SERIAL by design: `plan.nodes` is topologically ordered (dependencies before dependents),
    // and on the first failure nothing further may start — the catch undoes exactly what exists.
    for (const node of plan.nodes) {
      if (!node.newlyInstalled) continue;
      if (node.id === manifest.id) {
        const root = await installRootNode(options, sourceResolved, manifest, created); // NOSONAR S9382: topological, fail-fast install order (see above)
        assertInstalledEntryHash(root, options.expectedRootEntryHash);
        continue;
      }
      const dep = staged.get(node.id);
      if (dep === undefined) {
        throw new Error(`dependency ${node.id}@${node.version} was not staged`);
      }
      await installStagedDependency(options, channel, dep, created); // NOSONAR S9382: topological, fail-fast install order (see above)
    }
    recordPlanInstallAndAudit(
      options.db,
      plan,
      manifest,
      options.approve === undefined ? "not_required" : "approved",
    );
  } catch (e) {
    throw withRollbackFailures(e, rollbackCreatedPackages(options.db, created));
  } finally {
    if (stagingDir !== undefined) {
      try {
        rmSync(stagingDir, { recursive: true, force: true });
      } catch {
        /* best-effort: the staged trees are copies, never installed code */
      }
    }
  }
}

/** The options of {@link installPlanDependencies}: a registry resolution, never a local one. */
export interface PlanDependencyOptions {
  readonly db: Database;
  readonly extensionsDir: string;
  readonly vault?: NimbusVault;
  readonly registryPlan: RegistryPlanHooks;
  /** Where the packages are staged (default `os.tmpdir()`); a test seam. */
  readonly planStagingRoot?: string;
}

/** What {@link installPlanDependencies} installed, in plan order, and how to undo it. */
export interface InstalledPlanDependencies {
  readonly installed: readonly { readonly id: string; readonly version: string }[];
  /** Undoes every package installed here (edges, row, directory), newest first; returns what failed. */
  rollback(): RollbackFailure[];
}

/**
 * The dependency half of an ALREADY APPROVED plan whose root is installed elsewhere (an update's
 * root is swapped in by the update itself): stage every newly installed dependency from the
 * resolver that verified it, then install each in topological order through the same copy + I16
 * path, index key and index entry hash as a registry install's dependencies. A package that is
 * already installed (another install or update got there first) is refused before anything is
 * staged. Records no edge and no audit row: the caller records the edges with its own row write,
 * and calls `rollback` when that fails. Any failure here undoes every package created here; the
 * staging directory is always removed.
 */
export async function installPlanDependencies(
  options: PlanDependencyOptions,
  plan: { nodes: readonly ResolvedNode[] },
  rootId: string,
): Promise<InstalledPlanDependencies> {
  const newDeps = plan.nodes.filter((n) => n.newlyInstalled && n.id !== rootId);
  const installedIds = new Set(listExtensions(options.db).map((r) => r.id));
  for (const node of newDeps) {
    if (
      installedIds.has(node.id) ||
      existsSync(extensionInstallDirectory(options.extensionsDir, node.id))
    ) {
      throw new RegistryError(
        "ERR_REGISTRY_INSTALL_REFUSED",
        `${node.id} is already installed; the plan that would install ${node.id}@${node.version} is out of date`,
      );
    }
  }
  const created: CreatedPackage[] = [];
  let stagingDir: string | undefined;
  try {
    const staged = await stageNewDependencies(options, plan, rootId, () => {
      stagingDir = mkdtempSync(join(options.planStagingRoot ?? tmpdir(), PLAN_STAGING_PREFIX));
      return stagingDir;
    });
    // SERIAL by design, as in installApprovedPlan: topological order, fail-fast.
    for (const node of newDeps) {
      const dep = staged.get(node.id);
      if (dep?.version !== node.version) {
        throw new Error(`dependency ${node.id}@${node.version} was not staged`);
      }
      await installStagedDependency(options, options.registryPlan.channel, dep, created); // NOSONAR S9382: topological, fail-fast install order (see above)
    }
  } catch (e) {
    throw withRollbackFailures(e, rollbackCreatedPackages(options.db, created));
  } finally {
    if (stagingDir !== undefined) {
      try {
        rmSync(stagingDir, { recursive: true, force: true });
      } catch {
        /* best-effort: the staged trees are copies, never installed code */
      }
    }
  }
  return {
    installed: newDeps.map((n) => ({ id: n.id, version: n.version })),
    rollback: () => rollbackCreatedPackages(options.db, created),
  };
}

/** Thrown when the owner declined (or the gate timed out); nothing was written. */
export class ExtensionInstallNotApprovedError extends Error {
  constructor(id: string) {
    super(`ERR_EXTENSION_INSTALL_NOT_APPROVED: install of ${id} was not approved`);
    this.name = "ExtensionInstallNotApprovedError";
  }
}

const NO_PERMISSIONS: ExtensionManifest["permissions"] = {
  network: [],
  filesystem: { read: [], write: [] },
};

/** The manifest of an installed (reused) package, read from disk; undefined when unreadable. */
function installedManifestOf(db: Database, id: string): ExtensionManifest | undefined {
  const row = listExtensions(db).find((r) => r.id === id);
  const path = row === undefined ? undefined : resolveExtensionManifestPath(row.install_path);
  if (path === undefined) return undefined;
  try {
    return parseExtensionManifestJson(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function publisherOf(
  manifest: ExtensionManifest | undefined,
): { id: string; fingerprint: string } | null {
  return manifest?.publisher === undefined
    ? null
    : { id: manifest.publisher.id, fingerprint: publisherKeyFingerprint(manifest.publisher.key) };
}

/** What the owner is shown about one plan node, beyond its id, version, edges and registry. */
function plannedDetails(
  options: InstallFromLocalOptions,
  node: ResolvedNode,
  manifest: ExtensionManifest,
  rootBadge: VerifiedPublisher | null,
): Pick<
  PlannedPackage,
  "publisher" | "publisherBadge" | "publisherChange" | "publisherChangeNote" | "permissions"
> {
  if (node.id === manifest.id) {
    return {
      publisher: publisherOf(manifest),
      ...(rootBadge === null ? {} : { publisherBadge: publisherBadgeText(rootBadge) }),
      permissions: manifest.permissions,
    };
  }
  const verified = node.newlyInstalled
    ? options.registryPlan?.resolver.verified(node.id, node.version)
    : undefined;
  if (node.newlyInstalled && verified === undefined) {
    // The approval must never understate: a package about to be installed is shown from its
    // verified manifest, or the install is refused here, before the owner is asked.
    throw new RegistryError(
      "ERR_REGISTRY_INSTALL_REFUSED",
      `${node.id}@${node.version} would be installed but has no verified manifest to show in the approval`,
    );
  }
  if (verified === undefined) {
    const installed = installedManifestOf(options.db, node.id);
    return {
      publisher: publisherOf(installed),
      permissions: installed?.permissions ?? NO_PERMISSIONS,
    };
  }
  const pc = verified.publisherChange;
  return {
    publisher:
      verified.manifest.publisher === undefined
        ? null
        : {
            id: verified.manifest.publisher.id,
            fingerprint: publisherKeyFingerprint(verified.publisherKey),
          },
    ...(verified.verifiedPublisher === null
      ? {}
      : { publisherBadge: publisherBadgeText(verified.verifiedPublisher) }),
    ...(pc === null
      ? {}
      : {
          publisherChange: { ...pc.change, via: pc.via },
          publisherChangeNote: keyChangeNote(pc.change, pc.via),
        }),
    permissions: verified.manifest.permissions,
  };
}

function registryUrlOf(options: InstallFromLocalOptions, source: SourceKey): string | null {
  return (
    options.registryPlan?.resolver.registryUrl(source) ??
    getRegistry(options.db, registryNameOf(source))?.url ??
    null
  );
}

/** Every plan node as the owner is shown it, in plan (topological) order. */
function buildPlannedPackages(
  options: InstallFromLocalOptions,
  plan: { nodes: readonly ResolvedNode[] },
  manifest: ExtensionManifest,
  rootBadge: VerifiedPublisher | null,
): PlannedPackage[] {
  return plan.nodes.map((node) => ({
    id: node.id,
    version: node.version,
    requiredBy: plan.nodes.flatMap((from) =>
      from.deps.filter((d) => d.id === node.id).map((d) => ({ from: from.id, range: d.range })),
    ),
    registry: node.source === null ? null : registryNameOf(node.source),
    registryUrl: node.source === null ? null : registryUrlOf(options, node.source),
    ...plannedDetails(options, node, manifest, rootBadge),
    newlyInstalled: node.newlyInstalled,
  }));
}

/**
 * The plan fields of the request, or none: a single-package install (no dependency at all, and no
 * package from another registry than the root's) carries no `plan`, and a `planText` only when it
 * requires a connector (the `Needs:` block alone).
 */
function planFields(
  options: InstallFromLocalOptions,
  plan: { nodes: readonly ResolvedNode[] },
  manifest: ExtensionManifest,
  rootBadge: VerifiedPublisher | null,
  requirements: readonly ConnectorRequirementStatus[] | undefined,
): Pick<ExtensionInstallApprovalRequest, "plan" | "planPermissions" | "planText"> {
  const registryOf = (n: ResolvedNode): string | null =>
    n.source === null ? null : registryNameOf(n.source);
  const rootNode = plan.nodes.find((n) => n.id === manifest.id);
  const rootRegistry = rootNode === undefined ? null : registryOf(rootNode);
  const crossRegistry = plan.nodes.some((n) => {
    const r = registryOf(n);
    return r !== null && r !== rootRegistry;
  });
  if (plan.nodes.length <= 1 && !crossRegistry) {
    const needsOnly = withNeedsBlock(undefined, requirements);
    return needsOnly === undefined ? {} : { planText: needsOnly };
  }
  const packages = buildPlannedPackages(options, plan, manifest, rootBadge);
  const planPermissions = planPermissionsUnion(packages);
  return {
    plan: packages,
    planPermissions,
    planText: withNeedsBlock(renderInstallPlan(packages, planPermissions), requirements),
  };
}

/**
 * Every package this plan newly installs (the root included), with the manifest the approval is
 * built from and the registry root its row will record, so requirement status can see a
 * continuity-bound owner the plan is about to install (it has no run grant yet).
 */
function pendingInstallsOf(
  options: InstallFromLocalOptions,
  plan: { nodes: readonly ResolvedNode[] },
  manifest: ExtensionManifest,
): NonNullable<ConnectorRequirementDeps["pendingInstalls"]> {
  const out: Array<{ manifest: ExtensionManifest; sourceRootFingerprint: string | undefined }> = [];
  for (const n of plan.nodes) {
    if (!n.newlyInstalled) continue;
    if (n.id === manifest.id) {
      out.push({ manifest, sourceRootFingerprint: options.rootFingerprint });
      continue;
    }
    const verified = options.registryPlan?.resolver.verified(n.id, n.version);
    if (verified === undefined) continue;
    out.push({ manifest: verified.manifest, sourceRootFingerprint: verified.reg.rootFingerprint });
  }
  return out;
}

/**
 * The connector requirements of the root and every newly installed dependency, each read from the
 * manifest the approval is built from (the root's, and the dependency's VERIFIED registry
 * manifest), before anything is staged. Undefined without a Vault (nothing is computed), and
 * undefined when the computation fails: the approval then carries no requirements and no `Needs:`
 * block, and the install goes on — requirement status never refuses an install.
 */
async function planConnectorRequirements(
  options: InstallFromLocalOptions,
  plan: { nodes: readonly ResolvedNode[] },
  manifest: ExtensionManifest,
): Promise<ConnectorRequirementStatus[] | undefined> {
  const vault = options.vault;
  if (vault === undefined) return undefined;
  const compute = options.requirementStatuses ?? connectorRequirementStatuses;
  const manifests = [
    manifest,
    ...plan.nodes
      .filter((n) => n.newlyInstalled && n.id !== manifest.id)
      .map((n) => options.registryPlan?.resolver.verified(n.id, n.version)?.manifest),
  ];
  const required = manifests.flatMap((m) =>
    m?.requires === undefined ? [] : [{ extensionId: m.id, connectors: m.requires.connectors }],
  );
  try {
    return await compute(
      {
        db: options.db,
        vault,
        ...(options.continuityTable === undefined
          ? {}
          : { continuityTable: options.continuityTable }),
        pendingInstalls: pendingInstallsOf(options, plan, manifest),
      },
      required,
    );
  } catch {
    return undefined;
  }
}

function buildInstallApprovalRequest(
  options: InstallFromLocalOptions,
  manifest: ExtensionManifest,
  plan: { nodes: readonly ResolvedNode[] },
  sourcePath: string,
  badge: VerifiedPublisher | null,
  requirements: readonly ConnectorRequirementStatus[] | undefined,
): ExtensionInstallApprovalRequest {
  const others = plan.nodes
    .filter((n) => n.newlyInstalled && n.id !== manifest.id)
    .map((n) => ({ id: n.id, version: n.version }));
  return {
    id: manifest.id,
    version: manifest.version,
    sourcePath,
    publisher: publisherOf(manifest),
    permissions: manifest.permissions,
    installs: [{ id: manifest.id, version: manifest.version }, ...others],
    ...(options.sourceRegistry !== undefined && { sourceRegistry: options.sourceRegistry }),
    ...(options.rootFingerprint !== undefined && { rootFingerprint: options.rootFingerprint }),
    verifiedPublisher: badge,
    publisherBadge: publisherBadgeText(badge),
    ...planFields(options, plan, manifest, badge, requirements),
    ...(requirements === undefined ? {} : { connectorRequirements: requirements }),
  };
}

/**
 * The verified publisher (R6) to show in the install prompt — for a registry install only. The I16 check of the installed copy
 * runs only after approval, so the badge is asked only once the source manifest's signature has
 * been verified here with the key it declares — never on a claim alone.
 */
async function installPromptBadge(
  options: InstallFromLocalOptions,
  manifest: ExtensionManifest,
  manifestText: string,
): Promise<VerifiedPublisher | null> {
  const publisher = manifest.publisher;
  // R6 as amended 2026-10-27: a local-path install's manifest signature does not bind its entry
  // file (a registry install's index hashes do), so only a registry install is ever badged.
  if (publisher === undefined || options.sourceRegistry === undefined) return null;
  try {
    const raw = JSON.parse(manifestText) as Record<string, unknown>;
    await verifyManifestSignature(raw, decodeBase64(publisher.key));
  } catch {
    return null;
  }
  return verifiedPublisherFor(options.db, {
    publisherId: publisher.id,
    keyFingerprint: publisherKeyFingerprint(publisher.key),
    source:
      options.sourceRegistry !== undefined && options.rootFingerprint !== undefined
        ? { registry: options.sourceRegistry, rootFingerprint: options.rootFingerprint }
        : null,
  });
}

function recordPlanInstallAndAudit(
  db: Database,
  plan: { nodes: readonly ResolvedNode[] },
  manifest: ExtensionManifest,
  hitlStatus: "approved" | "not_required",
): void {
  const now = Date.now();
  db.transaction(() => {
    for (const node of plan.nodes) {
      recordInstall(db, node.id, node.version, node.deps, now);
    }
  })();

  appendAuditEntry(db, {
    actionType: "extension.install_complete",
    hitlStatus,
    actionJson: JSON.stringify({
      root: manifest.id,
      rootVersion: manifest.version,
      installed: plan.nodes.map((n) => ({
        id: n.id,
        version: n.version,
        newlyInstalled: n.newlyInstalled,
        deps: Object.fromEntries(n.deps.map((d) => [d.id, d.range])),
      })),
    }),
    timestamp: now,
  });
}

function buildRootInstallResult(
  extensionsDir: string,
  manifest: ExtensionManifest,
  plan: { nodes: readonly ResolvedNode[] },
): InstallExtensionFromLocalResult {
  const rootDest = extensionInstallDirectory(extensionsDir, manifest.id);
  const rootManifestPath = resolveExtensionManifestPath(rootDest);
  if (rootManifestPath === undefined) {
    throw new Error("root extension manifest missing after install — install may be corrupt");
  }
  const rootManifestHex = sha256HexOfBytes(readFileSync(rootManifestPath));

  const rootEntryRel = extensionEntryRelPath(manifest);
  const rootEntryPath = join(rootDest, rootEntryRel);
  const rootEntryHex = existsSync(rootEntryPath)
    ? sha256HexOfBytes(readFileSync(rootEntryPath))
    : "";

  return {
    id: manifest.id,
    version: manifest.version,
    installPath: rootDest,
    manifestHash: rootManifestHex,
    entryHash: rootEntryHex,
    treeDigest: computeExtensionTreeDigest(rootDest),
    installed: plan.nodes,
  };
}

interface InstallFromLocalOptions {
  db: Database;
  extensionsDir: string;
  sourcePath: string;
  vault?: NimbusVault;
  /** The continuity table requirement status binds legacy connector ids through (default the baked one). */
  continuityTable?: readonly ContinuityEntry[];
  /** Test seam: stands in for `connectorRequirementStatuses`; production never passes it. */
  requirementStatuses?: ConnectorRequirementStatusesFn;
  publisherKeyPath?: string;
  /** The publisher's Ed25519 key, supplied by a caller that already established it (a registry install). */
  publisherKey?: Uint8Array;
  /** Shown to the owner in the install prompt; set only by a registry install. */
  sourceRegistry?: string;
  rootFingerprint?: string;
  /**
   * The local owner's approval, asked after the plan resolves and before anything is written. The
   * production IPC path always supplies one (`ipc/automation-rpc.ts`); a direct library call
   * without one installs ungated and records the install audit row as `not_required`, never as
   * `approved`.
   */
  approve?: ExtensionInstallApprover;
  /** The path to show the owner when `sourcePath` is an archive's temporary extraction. */
  displaySourcePath?: string;
  /**
   * A registry install only: the dependency resolver the solve reads (phase 1, verified manifests
   * only) and the plan installer stages from (phase 2, after approval), and the channel the owner
   * asked for. Absent, only installed copies satisfy a dependency and nothing is fetched or staged.
   */
  registryPlan?: RegistryPlanHooks;
  /**
   * A registry install only: the entry-file hash the signed index lists for the root. Checked by
   * the plan installer after the root is copied and BEFORE any edge or audit row is recorded, so a
   * mismatch rolls back every package of the plan, dependencies included.
   */
  expectedRootEntryHash?: string;
  /** Where a registry plan's dependencies are staged (default `os.tmpdir()`); a test seam. */
  planStagingRoot?: string;
}

/** What a registry install hands the plan installer (see `InstallFromLocalOptions.registryPlan`). */
export interface RegistryPlanHooks {
  readonly resolver: RegistryDependencyResolver;
  readonly channel: RegistryChannel;
}

/** The archive install's options: the caller's, with `sourcePath` replaced by the archive path. */
function archiveInstallOptions(
  options: InstallFromLocalOptions,
  archivePath: string,
): Parameters<typeof installExtensionFromArchive>[0] {
  return {
    db: options.db,
    extensionsDir: options.extensionsDir,
    archivePath,
    ...(options.vault !== undefined && { vault: options.vault }),
    ...(options.continuityTable !== undefined && { continuityTable: options.continuityTable }),
    ...(options.publisherKeyPath !== undefined && {
      publisherKeyPath: options.publisherKeyPath,
    }),
    ...(options.publisherKey !== undefined && { publisherKey: options.publisherKey }),
    ...(options.sourceRegistry !== undefined && { sourceRegistry: options.sourceRegistry }),
    ...(options.rootFingerprint !== undefined && { rootFingerprint: options.rootFingerprint }),
    ...(options.approve !== undefined && { approve: options.approve }),
  };
}

/**
 * Asks the owner (when an approver is wired) to approve the resolved plan; throws
 * `ExtensionInstallNotApprovedError` on a refusal. Nothing has been written yet.
 */
async function requireInstallApproval(
  options: InstallFromLocalOptions,
  manifest: ExtensionManifest,
  manifestText: string,
  plan: { nodes: readonly ResolvedNode[] },
  sourceResolved: string,
): Promise<void> {
  if (options.approve === undefined) return;
  const approved = await options.approve(
    buildInstallApprovalRequest(
      options,
      manifest,
      plan,
      options.displaySourcePath ?? sourceResolved,
      await installPromptBadge(options, manifest, manifestText),
      await planConnectorRequirements(options, plan, manifest),
    ),
  );
  if (!approved) {
    throw new ExtensionInstallNotApprovedError(manifest.id);
  }
}

export async function installExtensionFromLocalDirectory(
  options: InstallFromLocalOptions,
): Promise<InstallExtensionFromLocalResult | PromotedInstallResult> {
  const sourceResolved = resolve(options.sourcePath);
  if (!existsSync(sourceResolved)) {
    throw new Error("extension source path does not exist");
  }
  const st = statSync(sourceResolved);
  if (st.isFile()) {
    const lower = sourceResolved.toLowerCase();
    if (!lower.endsWith(".tar.gz") && !lower.endsWith(".tgz")) {
      throw new Error("extension source file must be a .tar.gz or .tgz archive");
    }
    return await installExtensionFromArchive(archiveInstallOptions(options, sourceResolved));
  }
  if (!st.isDirectory()) {
    throw new Error("extension source path must be a directory or .tar.gz archive");
  }

  const srcManifestPath = resolveExtensionManifestPath(sourceResolved);
  if (srcManifestPath === undefined) {
    throw new Error(
      "extension manifest not found (expected nimbus.extension.json or nimbus-extension.json)",
    );
  }

  const manifestBytes = readFileSync(srcManifestPath);
  const manifest = parseExtensionManifestJson(manifestBytes.toString("utf8"));
  // A starter pack's entry IS its manifest, under the current name only (`extensionEntryRelPath`),
  // so a pack under the legacy name would otherwise fail later as a missing entry file.
  if (isStarterPack(manifest) && basename(srcManifestPath) !== EXTENSION_MANIFEST_FILENAME) {
    throw new RegistryError(
      "ERR_REGISTRY_MANIFEST_INVALID",
      `a starter pack's manifest must be named ${EXTENSION_MANIFEST_FILENAME}`,
    );
  }

  // An explicit install of the same package already installed as a dependency keeps it: before
  // solving and before the owner is asked, since it installs nothing.
  const promotable = promotableLocalDependency(options, manifest, manifestBytes);
  if (promotable !== undefined) return promoteInstalledDependency(options.db, promotable);
  assertNotAlreadyInstalledLocally(options, manifest);

  const { installed: installedMap, activeConstraints } = buildSolverInputs(options.db);

  // A registry install resolves through its registry (verified manifests only, I44); any other
  // install sees only what is installed and fetches nothing.
  const solverFetcher =
    options.registryPlan?.resolver.fetcher ?? buildLocalSolverFetcher(options.db, installedMap);

  const solverRoot: ExtensionManifestForSolver = {
    id: manifest.id,
    version: manifest.version,
    ...(manifest.dependsOn === undefined ? {} : { dependsOn: manifest.dependsOn }),
  };
  const rootSource =
    options.registryPlan?.resolver.rootSource ??
    (options.sourceRegistry !== undefined && options.rootFingerprint !== undefined
      ? sourceKey(options.sourceRegistry, options.rootFingerprint)
      : null);
  const plan = await resolveClosure(solverRoot, rootSource, solverFetcher, {
    installed: installedMap,
    activeConstraints,
  });

  // I48: code signed by a revoked key, or taken down, is refused before the owner is asked. The key
  // checked is the one the manifest declares: the signature step below verifies against exactly it.
  assertNotBlocked(options.db, {
    extensionId: manifest.id,
    version: manifest.version,
    publisherId: manifest.publisher?.id ?? null,
    keyFingerprint:
      manifest.publisher === undefined ? null : publisherKeyFingerprint(manifest.publisher.key),
    source:
      options.sourceRegistry !== undefined && options.rootFingerprint !== undefined
        ? { registry: options.sourceRegistry, rootFingerprint: options.rootFingerprint }
        : null,
  });
  await requireInstallApproval(
    options,
    manifest,
    manifestBytes.toString("utf8"),
    plan,
    sourceResolved,
  );

  // Stage, install in topological order, check every registry entry hash, record the edges and
  // the audit row — all or nothing.
  await installApprovedPlan(options, plan, sourceResolved, manifest);

  return buildRootInstallResult(options.extensionsDir, manifest, plan);
}
