import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { isStarterPack, publisherKeyFingerprint, RegistryError } from "@nimbus-dev/registry-format";
import type { NimbusVault } from "../vault/index.ts";
import type { ContinuityEntry } from "./continuity/continuity-table.ts";
import { resolveClosure } from "./dependency-graph.ts";
import type { ExtensionManifestForSolver, ResolvedNode } from "./dependency-types.ts";
import { extensionInstallDirectory, sha256HexOfBytes } from "./install-from-local/_shared.ts";
import {
  buildInstallApprovalRequest,
  installPromptBadge,
  planConnectorRequirements,
} from "./install-from-local/approval-request.ts";
import { ExtensionInstallNotApprovedError } from "./install-from-local/errors.ts";
import { installApprovedPlan } from "./install-from-local/plan-install.ts";
import {
  assertNotAlreadyInstalledLocally,
  promotableLocalDependency,
  promoteInstalledDependency,
} from "./install-from-local/promotion.ts";
import {
  buildLocalSolverFetcher,
  buildSolverInputs,
  rootSourceOf,
} from "./install-from-local/solver-inputs.ts";
import type {
  ExtensionInstallApprover,
  InstallExtensionFromLocalResult,
  InstallFromLocalOptions,
  PromotedInstallResult,
} from "./install-from-local/types.ts";
import {
  EXTENSION_MANIFEST_FILENAME,
  type ExtensionManifest,
  extensionEntryRelPath,
  parseExtensionManifestJson,
  resolveExtensionManifestPath,
} from "./manifest.ts";
import { extractPackage } from "./package-extract.ts";
import { computeExtensionTreeDigest } from "./tree-digest.ts";
import { assertNotBlocked } from "./trust/trust-blocks.ts";

export { extensionInstallDirectory } from "./install-from-local/_shared.ts";
export { ExtensionInstallNotApprovedError } from "./install-from-local/errors.ts";
export { installPlanDependencies } from "./install-from-local/plan-install.ts";
export {
  installedDependencyRow,
  installedKindOf,
  isPromotedInstall,
  promoteInstalledDependency,
} from "./install-from-local/promotion.ts";
export {
  reportIncompleteRollback,
  rollbackFailuresOf,
  rollbackIncompleteDetail,
  rollbackIncompleteNote,
} from "./install-from-local/rollback.ts";
export { buildSolverInputs } from "./install-from-local/solver-inputs.ts";
export type {
  ExtensionInstallApprovalRequest,
  ExtensionInstallApprover,
  InstallExtensionFromLocalResult,
  InstalledPlanDependencies,
  PlanDependencyOptions,
  PromotedInstallResult,
  RegistryPlanHooks,
  RollbackFailure,
} from "./install-from-local/types.ts";
export type { PlannedPackage } from "./install-plan-text.ts";

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

/**
 * A starter pack's entry IS its manifest, under the current name only (`extensionEntryRelPath`),
 * so a pack under the legacy name would otherwise fail later as a missing entry file.
 */
function assertStarterPackManifestName(manifest: ExtensionManifest, manifestPath: string): void {
  if (isStarterPack(manifest) && basename(manifestPath) !== EXTENSION_MANIFEST_FILENAME) {
    throw new RegistryError(
      "ERR_REGISTRY_MANIFEST_INVALID",
      `a starter pack's manifest must be named ${EXTENSION_MANIFEST_FILENAME}`,
    );
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
  assertStarterPackManifestName(manifest, srcManifestPath);

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
  const rootSource = rootSourceOf(options);
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
