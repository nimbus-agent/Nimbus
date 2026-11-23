import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RegistryChannel, RegistryError } from "@nimbus-dev/registry-format";
import { listExtensions, setInstalledAsDependency } from "../../automation/extension-store.ts";
import { appendAuditEntry } from "../../db/audit-chain.ts";
import { sha256HexEqualConstantTime } from "../../util/timing-safe-compare.ts";
import { recordInstall } from "../dependency-store.ts";
import type { ResolvedNode } from "../dependency-types.ts";
import type { ExtensionManifest } from "../manifest.ts";
import type { StagedDependency } from "../registry/registry-dependency-fetcher.ts";
import { registryHashMismatch } from "../registry/registry-manifest.ts";
import { setExtensionSource } from "../registry/registry-store.ts";
import { decodeBase64 } from "../verify-signature.ts";
import { extensionInstallDirectory } from "./_shared.ts";
import {
  installDirectoryIsOwned,
  installRootNode,
  leftoverDirectoryMessage,
} from "./copy-and-verify.ts";
import { rollbackCreatedPackages, withRollbackFailures } from "./rollback.ts";
import type {
  CreatedPackage,
  InstalledPlanDependencies,
  InstallFromLocalOptions,
  PlanDependencyOptions,
  SingleInstallResult,
} from "./types.ts";

/**
 * The plan installer stages a registry plan's dependencies under `<root>/<prefix>XXXXXX`, where
 * `<root>` is `planStagingRoot` (default `tmpdir()`).
 */
const PLAN_STAGING_PREFIX = "nimbus-plan-";

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
  // `installRootNode` runs in this tick, so it can no longer be the one that fires. A directory no
  // row owns is a leftover from an earlier failed install, and is named as one.
  const depDir = extensionInstallDirectory(options.extensionsDir, dep.id);
  if (existsSync(depDir)) {
    throw new RegistryError(
      "ERR_REGISTRY_INSTALL_REFUSED",
      installDirectoryIsOwned(options.db, dep.id, depDir)
        ? `${dep.id} was installed while this plan was being installed; the plan that would install ${dep.id}@${dep.version} is out of date`
        : leftoverDirectoryMessage(depDir),
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
export async function installApprovedPlan(
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
    const dir = extensionInstallDirectory(options.extensionsDir, node.id);
    const dirInTheWay = !installedIds.has(node.id) && existsSync(dir);
    if (dirInTheWay && !installDirectoryIsOwned(options.db, node.id, dir)) {
      // A directory no row owns is a leftover from an earlier failed install, not an installed package.
      throw new RegistryError("ERR_REGISTRY_INSTALL_REFUSED", leftoverDirectoryMessage(dir));
    }
    if (installedIds.has(node.id) || dirInTheWay) {
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

export function recordPlanInstallAndAudit(
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
