/**
 * Install an extension from a registry (spec § 8.6). Registry bytes become installed code here, so
 * the order is the point: every hash and the publisher signature are checked BEFORE anything is
 * extracted, the Vault is consulted BEFORE the owner is asked, and the owner is asked (inside
 * `installExtensionFromLocalDirectory`) BEFORE a byte lands in the install tree.
 */
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isStarterPack,
  provenanceMatching,
  provenanceNote,
  publisherKeyFingerprint,
  type RegistryChannel,
  RegistryError,
  type RegistryIndex,
  type RegistryVersionEntry,
  readManifestRepository,
  type VersionProvenance,
} from "@nimbus-dev/registry-format";
import { type ExtensionRow, listExtensions } from "../../automation/extension-store.ts";
import { sha256HexEqualConstantTime } from "../../util/timing-safe-compare.ts";
import type { NimbusVault } from "../../vault/index.ts";
import type {
  AddedPackage,
  AvailableUpdate,
  UpdatePlan,
  UpdatePlanContext,
} from "../auto-update-types.ts";
import type { ConnectorRequirementStatusesFn } from "../connector-requirements.ts";
import type { ContinuityEntry } from "../continuity/continuity-table.ts";
import {
  conflictErrorsOf,
  DependencyConflictError,
  DependencyConflictsError,
  describeDependencyConflict,
} from "../dependency-errors.ts";
import { assertRootConstraintsSatisfied, resolveClosure } from "../dependency-graph.ts";
import {
  type ExtensionManifestForSolver,
  type InstallPlan,
  registryNameOf,
} from "../dependency-types.ts";
import {
  buildSolverInputs,
  type ExtensionInstallApprovalRequest,
  type ExtensionInstallApprover,
  ExtensionInstallNotApprovedError,
  type InstallExtensionFromLocalResult,
  type InstalledPlanDependencies,
  installExtensionFromLocalDirectory,
  installedDependencyRow,
  installPlanDependencies,
  isPromotedInstall,
  type PromotedInstallResult,
  promoteInstalledDependency,
  rollbackFailuresOf,
} from "../install-from-local.ts";
import {
  type PlannedPackage,
  planPermissionsUnion,
  renderInstallPlan,
  withNeedsBlock,
} from "../install-plan-text.ts";
import type { ExtensionManifest } from "../manifest.ts";
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
import { currentSourceRegistry, sourceRegistryOf } from "./builtin-registry.ts";
import { createRegistryDependencyResolver } from "./registry-dependency-fetcher.ts";
import {
  FETCH_FAILURE_CODES,
  fetchVerifiedIndex,
  type RegistryFetchDeps,
} from "./registry-fetch.ts";
import { fetchRegistryManifest, verifyRegistryManifestSignature } from "./registry-manifest.ts";
import {
  assertEmptyStagingDir,
  extractVerifiedPackage,
  fetchHashedPackage,
} from "./registry-package-stage.ts";
import { resolveRegistryEntry } from "./registry-resolve.ts";
import { getExtensionSource, type RegistryRow, setExtensionSource } from "./registry-store.ts";
import {
  evidenceApprovalFields,
  type VersionEvidence,
  versionEvidence,
} from "./version-evidence.ts";

export { MAX_REGISTRY_MANIFEST_BYTES } from "./registry-manifest.ts";

export interface InstallFromRegistryDeps {
  db: Database;
  extensionsDir: string;
  vault: NimbusVault;
  fetch: Omit<RegistryFetchDeps, "db">;
  approve: ExtensionInstallApprover;
  /** Where the plan installer stages a plan's dependencies (default `os.tmpdir()`); a test seam. */
  planStagingRoot?: string;
  /** Where the per-install download directory is created (default `os.tmpdir()`); a test seam. */
  tempRoot?: string;
  /** The continuity table the approval's connector requirements bind through (default the baked one). */
  continuityTable?: readonly ContinuityEntry[];
  /** Test seam: stands in for `connectorRequirementStatuses`; production never passes it. */
  requirementStatuses?: ConnectorRequirementStatusesFn;
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
  /** The dependencies this install added (newly installed, in install order), each with its registry. */
  dependencies: readonly { id: string; version: string; registry: string }[];
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
  /**
   * The build provenance the registry recorded for this version (trust layer PR 4c), only when the
   * hash-checked, signature-verified manifest names the same repository; else null.
   */
  readonly provenance: VersionProvenance | null;
  /**
   * What the registry's signed entry says about this version (tested, history, checks), shown in
   * the install approval. Optional as `index` is: a package built elsewhere (a test fake, a
   * migration) states none, and its approval then carries none of these lines.
   */
  readonly evidence?: VersionEvidence;
  /**
   * The verified index the fetch resolved the package from, so a dependency resolver over the same
   * registry need not read it again. Optional: a package built elsewhere (a test fake) has none.
   */
  readonly index?: RegistryIndex;
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
  const { reg, index, entry } = await resolveRegistryEntry(fetchDeps, req.id, req.registry);
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
  // Hashes first: nothing is verified or extracted from bytes the index did not sign.
  const packageBytes = await fetchHashedPackage(fetchDeps, reg, req.id, version, vEntry);
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

  const { sourceRoot } = await extractVerifiedPackage(
    packageBytes,
    req.id,
    version,
    vEntry,
    manifest,
    intoDir,
  );
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
    provenance:
      provenanceMatching(vEntry, readManifestRepository(JSON.parse(fetched.text) as unknown)) ??
      null,
    evidence: versionEvidence({
      registry: reg.name,
      versions: entry.versions,
      version,
      declaresNetwork: manifest.permissions.network.length > 0,
      starterPack: isStarterPack(manifest),
      now: deps.fetch.now(),
    }),
    index,
  };
}

/**
 * The plan fields of `request` with the root's entry patched (a key change the root's fetch found):
 * the structured `plan` and the rendered `planText` agree with the request's own fields.
 */
function planWithRoot(
  request: ExtensionInstallApprovalRequest,
  patch: Partial<PlannedPackage>,
): Pick<ExtensionInstallApprovalRequest, "plan" | "planText"> {
  if (request.plan === undefined) return {};
  const plan = request.plan.map((p) => (p.id === request.id ? { ...p, ...patch } : p));
  return {
    plan,
    // Re-rendered with the same `Needs:` block, so the patched prompt never drops a requirement.
    planText: withNeedsBlock(
      renderInstallPlan(plan, request.planPermissions ?? planPermissionsUnion(plan)),
      request.connectorRequirements,
    ),
  };
}

/** The approver, showing a publisher key change (fingerprints, and what vouched for it) when there is one. */
function withKeyChange(
  approve: ExtensionInstallApprover,
  pc: VerifiedRegistryPackage["publisherChange"],
): ExtensionInstallApprover {
  if (pc === null) return approve;
  const change = {
    publisherChange: { ...pc.change, via: pc.via },
    publisherChangeNote: keyChangeNote(pc.change, pc.via),
  };
  return (request) => approve({ ...request, ...change, ...planWithRoot(request, change) });
}

/** The approver, showing the version's registry-verified build provenance when there is one. */
function withProvenance(
  approve: ExtensionInstallApprover,
  provenance: VersionProvenance | null,
  registry: string,
): ExtensionInstallApprover {
  if (provenance === null) return approve;
  return (request) =>
    approve({ ...request, provenance, provenanceNote: provenanceNote(provenance, registry) });
}

/**
 * The approver, stating the package's evidence (tested, history, checks) when it has some, and
 * scoping it to the root when the plan installs more than one package.
 */
function withEvidence(
  approve: ExtensionInstallApprover,
  evidence: VersionEvidence | undefined,
): ExtensionInstallApprover {
  if (evidence === undefined) return approve;
  return (request) =>
    approve({
      ...request,
      ...evidenceApprovalFields(evidence, request.id, request.plan?.length ?? 1),
    });
}

/** How `installVerifiedRegistryPackage` treats the package's dependencies. */
export interface InstallVerifiedRegistryPackageOptions {
  /**
   * `"registry"` (the default, the registry install door): a missing dependency is fetched through
   * the registry-scoped resolver and shown in the one approval. `"installed-only"` (the migration
   * engine, whose `extension.migrate` consent names only the root): no resolver is built and
   * nothing is fetched — a dependency must already be installed (from any source), or the install
   * is refused, so exactly one package is installed.
   */
  readonly dependencies?: "registry" | "installed-only";
}

/**
 * Installs a package `fetchVerifiedRegistryPackage` already verified, with every dependency it is
 * missing: the Vault is already checked; the solve reads each dependency's manifest only through a
 * registry-scoped resolver (I44: verified index, manifest hash, I16 signature, Vault, I48); the owner
 * is asked ONCE (inside `installExtensionFromLocalDirectory`), over every package, before a byte
 * lands in the install tree; and the plan installer then stages, installs and entry-hash-checks
 * every package — this one included, against `pkg.entryHash` — all or nothing. `channel` is the one
 * the owner ASKED for (spec § 8.1), not the resolved version's: a `--channel beta` install that
 * resolved to a stable version keeps tracking beta, and its dependencies are chosen on it too.
 * The staged tree under `pkg.sourceRoot` is left for the caller to remove.
 */
export async function installVerifiedRegistryPackage(
  deps: InstallFromRegistryDeps,
  pkg: VerifiedRegistryPackage,
  channel: RegistryChannel,
  options: InstallVerifiedRegistryPackageOptions = {},
): Promise<RegistryInstallResult> {
  const { id, version, reg, rootFingerprint } = pkg;
  const publisher = pkg.manifest.publisher;
  if (publisher === undefined) {
    throw new RegistryError(
      "ERR_REGISTRY_MANIFEST_MISMATCH",
      `the verified manifest of ${id}@${version} names no publisher`,
    );
  }
  // One resolver per install: it is single-solve (a refused index read is remembered). None at all
  // for an installed-only install: its dependencies resolve against installed copies only.
  const resolver =
    options.dependencies === "installed-only"
      ? undefined
      : createRegistryDependencyResolver(deps, {
          reg,
          channel,
          ...(pkg.index === undefined ? {} : { index: pkg.index }),
        });
  let installed: InstallExtensionFromLocalResult | PromotedInstallResult;
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
      approve: withEvidence(
        withProvenance(
          withKeyChange(deps.approve, pkg.publisherChange),
          pkg.provenance,
          pkg.reg.name,
        ),
        pkg.evidence,
      ),
      ...(resolver === undefined ? {} : { registryPlan: { resolver, channel } }),
      ...(deps.planStagingRoot === undefined ? {} : { planStagingRoot: deps.planStagingRoot }),
      ...(deps.continuityTable === undefined ? {} : { continuityTable: deps.continuityTable }),
      ...(deps.requirementStatuses === undefined
        ? {}
        : { requirementStatuses: deps.requirementStatuses }),
      // Checked by the plan installer before anything is recorded: a mismatch undoes every package.
      expectedRootEntryHash: pkg.entryHash,
    });
  } catch (e) {
    if (
      e instanceof RegistryError ||
      e instanceof ExtensionInstallNotApprovedError ||
      e instanceof TrustBlockError
    ) {
      throw e;
    }
    // The refusal code changes; what the plan rollback could not undo is carried over unchanged.
    const failures = rollbackFailuresOf(e);
    throw Object.assign(
      new RegistryError("ERR_REGISTRY_INSTALL_REFUSED", e instanceof Error ? e.message : String(e)),
      { cause: e },
      failures.length === 0 ? {} : { rollbackFailures: failures },
    );
  }
  // Unreachable: a registry-driven local install never promotes (the fetch refused an installed id).
  if (isPromotedInstall(installed)) {
    throw new RegistryError("ERR_REGISTRY_ALREADY_INSTALLED", `${id} is already installed`);
  }
  setExtensionSource(deps.db, installed.id, { registry: reg.name, rootFingerprint, channel });
  return {
    ...installed,
    sourceRegistry: reg.name,
    rootFingerprint,
    publisher: { id: publisher.id, fingerprint: publisherKeyFingerprint(pkg.publisherKey) },
    dependencies: installed.installed.flatMap((n) =>
      n.newlyInstalled && n.id !== id && n.source !== null
        ? [{ id: n.id, version: n.version, registry: registryNameOf(n.source) }]
        : [],
    ),
  };
}

/**
 * The installed dependency an explicit registry install keeps instead of refusing (spec § 8.1), or
 * `undefined`. Only a dependency with a recorded registry source is promotable. A request that
 * names another version, or another registry or channel than the one the dependency came from, is
 * not a request for the installed copy: it is refused as before.
 */
function promotableRegistryDependency(
  db: Database,
  req: InstallFromRegistryRequest,
): ExtensionRow | undefined {
  const row = installedDependencyRow(db, req.id);
  if (row === undefined) return undefined;
  if (req.version !== undefined && req.version !== row.version) return undefined;
  const source = getExtensionSource(db, req.id);
  // A dependency with no recorded registry source came in some other way (a local folder): a
  // registry install never vouches for it.
  if (source === undefined) return undefined;
  if (req.registry !== undefined && req.registry !== source.registry) return undefined;
  if (req.channel !== undefined && req.channel !== source.channel) return undefined;
  return row;
}

export async function installFromRegistry(
  deps: InstallFromRegistryDeps,
  req: InstallFromRegistryRequest,
): Promise<RegistryInstallResult | PromotedInstallResult> {
  // Before any fetch: a promotion makes no network request and appends no egress row.
  const promotable = promotableRegistryDependency(deps.db, req);
  if (promotable !== undefined) return promoteInstalledDependency(deps.db, promotable);
  const tmp = mkdtempSync(join(deps.tempRoot ?? tmpdir(), "nimbus-reg-"));
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

/**
 * Solves an update's dependency closure through the same registry-scoped resolver a registry install
 * uses (I44): the update's own recorded source registry, still pinned to the root key it was
 * detected under, and each dependency from the registry its declaration resolves to among those the
 * owner added — through the verified chain (pinned root key, index hashes, I16 signature, Vault
 * publisher keys, I48 blocks). Nothing is installed or staged: the returned resolver holds the
 * verified manifests, and the apply stages exactly the plan's added packages from it.
 *
 * The installed OLD version stays in the solver's `installed` map, so the root node is newly
 * installed at `toVersion`, while its own old edges are dropped from the active constraints so they
 * do not constrain the new version. Installed dependents' ranges on the root are checked first
 * (`resolveClosure` does not check constraints on the root itself).
 *
 * Throws `DependencyConflictError` (a range nothing satisfies, a cycle), `RegistryError` (a
 * dependency naming a registry the owner has not added, a source mismatch, a refused manifest),
 * `OfflineDependencyResolutionError` (a registry could not be reached), or
 * `source_registry_changed: …` when the source registry was removed or re-pinned.
 */
export async function planUpdate(
  deps: InstallFromRegistryDeps,
  update: Pick<
    AvailableUpdate,
    "id" | "toVersion" | "channel" | "sourceRegistry" | "rootFingerprint"
  >,
  newManifest: ExtensionManifestForSolver,
  context: UpdatePlanContext = {},
): Promise<UpdatePlan> {
  if (newManifest.id !== update.id || newManifest.version !== update.toVersion) {
    throw new Error(
      `the manifest to plan is ${newManifest.id}@${newManifest.version}, not the update's ${update.id}@${update.toVersion}`,
    );
  }
  const reg = sourceRegistryOf({ ...deps.fetch, db: deps.db }, update);
  const { installed, activeConstraints } = buildSolverInputs(deps.db);
  const constraints = new Map(activeConstraints);
  constraints.delete(update.id);
  // Every conflict is reported (one line each): one on the root itself does not stop the solve.
  let rootConflict: DependencyConflictError | undefined;
  try {
    assertRootConstraintsSatisfied(update.id, update.toVersion, constraints);
  } catch (e) {
    if (!(e instanceof DependencyConflictError)) throw e;
    rootConflict = e;
  }
  // The channel the install TRACKS (spec § 8.1), as a registry install chooses its dependencies on.
  const channel = getExtensionSource(deps.db, update.id)?.channel ?? update.channel;
  const resolver = createRegistryDependencyResolver(deps, {
    reg,
    channel,
    // The detector's verified read of the source index, only for the registry it came from.
    ...(context.index === undefined ? {} : { index: context.index }),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    // One detection poll's index reads, shared by all of its plans (never across polls).
    ...(context.indexes === undefined ? {} : { indexes: context.indexes }),
  });
  let plan: InstallPlan;
  try {
    plan = await resolveClosure(newManifest, resolver.rootSource, resolver.fetcher, {
      installed,
      activeConstraints: constraints,
      collectConflicts: true,
    });
  } catch (e) {
    throw rootConflict === undefined
      ? e
      : new DependencyConflictsError([rootConflict, ...conflictErrorsOf(e)]);
  }
  if (rootConflict !== undefined) throw rootConflict;
  const addedPackages: AddedPackage[] = plan.nodes.flatMap((n) =>
    n.newlyInstalled && n.id !== update.id && n.source !== null
      ? [
          {
            id: n.id,
            version: n.version,
            registry: registryNameOf(n.source),
            registryUrl: resolver.registryUrl(n.source),
          },
        ]
      : [],
  );
  return { resolver, plan, addedPackages };
}

/** `<phase>: <message>`, keeping the rollback failures the plan installer attached. */
function phasedError(phase: string, e: unknown): Error {
  const out = new Error(`${phase}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  const failures = rollbackFailuresOf(e);
  if (failures.length > 0) Object.assign(out, { rollbackFailures: failures });
  return out;
}

/** The audit phase of a failed dependency install (as the root's re-verification classifies it). */
function dependencyFailurePhase(e: unknown): string {
  if (e instanceof TrustBlockError) return "trust_blocked";
  if (e instanceof RegistryError && FETCH_FAILURE_CODES.has(e.code)) return "download_failed";
  if (e instanceof RegistryError && e.code === "ERR_REGISTRY_INSTALL_REFUSED") {
    return "update_conflicts";
  }
  return "signature_failed";
}

/**
 * Refused unless the plan installs exactly the packages the owner approved (`addedPackages`), no
 * more and no other version.
 */
function assertPlanIsApproved(rootId: string, approved: UpdatePlan): void {
  const planned = approved.plan.nodes
    .filter((n) => n.newlyInstalled && n.id !== rootId)
    .map((n) => `${n.id}@${n.version}`)
    .sort((a, b) => a.localeCompare(b));
  const listed = approved.addedPackages
    .map((a) => `${a.id}@${a.version}`)
    .sort((a, b) => a.localeCompare(b));
  if (planned.join(",") !== listed.join(",")) {
    throw new Error(
      `update_conflicts: the plan installs ${planned.join(", ") || "nothing"} but the approval listed ${listed.join(", ") || "nothing"}`,
    );
  }
}

/**
 * Before anything is staged, each approved package is re-checked as it stands NOW: its registry is
 * still the one the owner added under the same root key (I44), nothing blocks it (I48), and that
 * registry's CURRENT signed index still lists exactly the verified manifest, package and key. A
 * version taken down or withdrawn since the approval is refused, never installed from memory.
 */
async function recheckApprovedPackages(
  deps: InstallFromRegistryDeps,
  approved: UpdatePlan,
  signal: AbortSignal | undefined,
): Promise<void> {
  const fetchDeps: RegistryFetchDeps = { ...deps.fetch, db: deps.db };
  const verified = approved.addedPackages.map((a) => {
    const v = approved.resolver.verified(a.id, a.version);
    if (v === undefined) {
      throw new Error(
        `update_conflicts: ${a.id}@${a.version} has no verified manifest in the approved plan`,
      );
    }
    return v;
  });
  for (const v of verified) {
    try {
      assertNotBlocked(deps.db, {
        extensionId: v.id,
        version: v.version,
        publisherId: v.manifest.publisher?.id ?? null,
        keyFingerprint: publisherKeyFingerprint(v.publisherKey),
        source: { registry: v.reg.name, rootFingerprint: v.reg.rootFingerprint },
      });
    } catch (e) {
      throw phasedError("trust_blocked", e);
    }
  }
  const indexes = new Map<string, Promise<RegistryIndex>>();
  for (const v of verified) {
    const reg = currentSourceRegistry(fetchDeps, {
      sourceRegistry: v.reg.name,
      rootFingerprint: v.reg.rootFingerprint,
    });
    if (reg === undefined) {
      throw new Error(
        `source_registry_changed: registry "${v.reg.name}" of ${v.id} was removed or re-pinned since the update was approved`,
      );
    }
    const key = `${reg.name}#${reg.rootFingerprint}`;
    let read = indexes.get(key);
    if (read === undefined) {
      read = fetchVerifiedIndex(fetchDeps, reg, signal);
      indexes.set(key, read);
    }
    let index: RegistryIndex;
    try {
      index = await read; // NOSONAR S9382: one verified read per registry, in plan order
    } catch (e) {
      throw phasedError(dependencyFailurePhase(e), e);
    }
    const entry = index.extensions[v.id];
    const now = entry?.versions[v.version];
    if (
      entry === undefined ||
      now === undefined ||
      entry.publisher.key !== v.publisherKey ||
      entry.publisher.id !== v.manifest.publisher?.id ||
      !sha256HexEqualConstantTime(now.manifestSha256, v.vEntry.manifestSha256) ||
      !sha256HexEqualConstantTime(now.packageSha256, v.vEntry.packageSha256) ||
      now.package !== v.vEntry.package ||
      !sha256HexEqualConstantTime(now.entryHash, v.vEntry.entryHash)
    ) {
      throw new Error(
        `signature_failed: the index of ${reg.name} no longer lists the approved ${v.id}@${v.version}`,
      );
    }
  }
}

/**
 * The apply half of an update's plan (I44): installs exactly the packages the owner approved in
 * the `extension.autoUpdate` prompt, each from the registry its declaration resolved to, through
 * the resolver that verified it at the gate — re-checked first (`recheckApprovedPackages`), then
 * staged and installed all or nothing by the plan installer. The update's root is not installed
 * here: the caller swaps it in, records every edge with its row, and calls `rollback` on failure.
 * Every error message starts with its audit phase.
 */
export async function installUpdateDependencies(
  deps: InstallFromRegistryDeps,
  update: Pick<AvailableUpdate, "id" | "toVersion" | "channel">,
  approved: UpdatePlan,
  signal?: AbortSignal,
): Promise<InstalledPlanDependencies> {
  assertPlanIsApproved(update.id, approved);
  // Another extension may have come to constrain the root since the gate.
  const { activeConstraints } = buildSolverInputs(deps.db);
  const constraints = new Map(activeConstraints);
  constraints.delete(update.id);
  try {
    assertRootConstraintsSatisfied(update.id, update.toVersion, constraints);
  } catch (e) {
    throw e instanceof DependencyConflictError
      ? new Error(`update_conflicts: ${describeDependencyConflict(e.conflict)}`, { cause: e })
      : e;
  }
  await recheckApprovedPackages(deps, approved, signal);
  // The channel the install TRACKS, as `planUpdate` resolved the dependencies on.
  const channel = getExtensionSource(deps.db, update.id)?.channel ?? update.channel;
  try {
    return await installPlanDependencies(
      {
        db: deps.db,
        extensionsDir: deps.extensionsDir,
        vault: deps.vault,
        registryPlan: { resolver: approved.resolver, channel },
        ...(deps.planStagingRoot === undefined ? {} : { planStagingRoot: deps.planStagingRoot }),
      },
      approved.plan,
      update.id,
    );
  } catch (e) {
    throw phasedError(dependencyFailurePhase(e), e);
  }
}
