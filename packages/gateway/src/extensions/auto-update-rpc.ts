import {
  isStarterPack,
  isValidSemver,
  publisherKeyFingerprint,
  RegistryError,
} from "@nimbus-dev/registry-format";
import { updateConflictsHint } from "./auto-update.ts";
import type { AutoUpdateCache } from "./auto-update-cache.ts";
import {
  ACTION_TYPE_AUTO_UPDATE,
  ACTION_TYPE_DOWNGRADE,
  type AutoUpdateFailPhase,
  type AvailableUpdate,
  type DowngradeOutcome,
  type ShownAddedPackage,
  type UpdateApplyResult,
  type UpdatePlan,
  type UpgradeOutcome,
} from "./auto-update-types.ts";
import type { ConnectorRequirementStatus } from "./connector-requirements.ts";
import { planPermissionsUnion, renderUpdatePlan, withNeedsBlock } from "./install-plan-text.ts";
import { keyChangeNote } from "./trust/publisher-key-decision.ts";
import { publisherBadgeText, type VerifiedPublisher } from "./trust/verified-publisher.ts";

interface PlannedAction {
  type: typeof ACTION_TYPE_AUTO_UPDATE | typeof ACTION_TYPE_DOWNGRADE;
  payload: Record<string, unknown>;
}

type GateResult = "proceed" | { status: "rejected" };

export interface AutoUpdateRpcDeps {
  cache: AutoUpdateCache;
  forcePoll: () => Promise<void>;
  gate: (action: PlannedAction) => Promise<GateResult>;
  /**
   * Solves a forward update's dependencies through its registries (`planUpdate`, I44) BEFORE the
   * owner is asked: the approval lists every package it adds, and the same plan is handed to the
   * apply. Throws when the update cannot be planned, which refuses it (`update_conflicts`).
   */
  planUpdate: (cached: AvailableUpdate) => Promise<UpdatePlan>;
  /**
   * Whether each connector the update newly requires (the root's added requirements and every
   * added package's) is connected, read before the owner is asked. Absent, or throwing ⇒ none
   * shown; requirement status never refuses an update.
   */
  updateRequirements?: (
    cached: AvailableUpdate,
    plan: UpdatePlan,
  ) => Promise<readonly ConnectorRequirementStatus[] | undefined>;
  /**
   * Applies an approved forward update with the plan its approval listed; reports the dependencies
   * its new version no longer declares that are now needed by nothing.
   */
  performUpgrade: (cached: AvailableUpdate, plan: UpdatePlan) => Promise<UpgradeOutcome>;
  /** Restores the previous version and its edges; reports the dependencies it left orphaned. */
  performDowngrade: (cached: AvailableUpdate) => Promise<DowngradeOutcome>;
  appendAudit: (type: string, payload: Record<string, unknown>) => Promise<void>;
  getInstalledVersion: (id: string) => Promise<string | null>;
  hasPrevVersion: (id: string, version: string) => Promise<boolean>;
  /**
   * Whether the extension holds a run grant. A grant names one version + tree digest, so an update
   * leaves it stale and the prompt says so (`runGrantNote`). Absent ⇒ no note.
   */
  hasRunGrant?: (id: string) => Promise<boolean>;
  /**
   * Whether the update's source registry still exists with the root fingerprint it was detected
   * under. Absent ⇒ not checked here (apply still re-checks it).
   */
  isSourceCurrent?: (cached: AvailableUpdate) => Promise<boolean>;
  /**
   * The verified publisher (R6) of a cached update's key, asked each time an update is served or
   * prompted — never stored on the cache entry, so a verification replaced or a key revoked after
   * detection takes the badge away at once. Absent ⇒ every update shows as unverified.
   */
  verifiedPublisherOf?: (cached: AvailableUpdate) => VerifiedPublisher | null;
}

const mutex = new Map<string, Promise<void>>();

/** The consent note an update shows when it will leave the extension's run grant stale. */
export function runGrantNoteFor(id: string): string {
  return `Running the new version will need a new \`nimbus extension approve ${id}\`.`;
}

/**
 * The consent note an update shows when it turns an extension holding a run grant into a starter
 * pack: the grant goes, and `approve` refuses a pack, so the re-approve note would mislead.
 */
export const STARTER_PACK_UPDATE_NOTE =
  "The new version is a starter pack: it has no code to run, and its approval to run is removed.";

/** R6 for an update: never a badge for code whose signature did not verify. */
function updateBadge(cached: AvailableUpdate, deps: AutoUpdateRpcDeps): VerifiedPublisher | null {
  if (cached.verificationStatus !== "verified") return null;
  return deps.verifiedPublisherOf?.(cached) ?? null;
}

function publisherChangeFields(cached: AvailableUpdate): Record<string, unknown> {
  const change = cached.publisherKeyChange;
  if (change === undefined) return {};
  const via = cached.acceptedPublisherKey === undefined ? (change.via ?? "rotation") : "owner";
  return {
    publisherChange: { from: [...change.from], to: change.to, via },
    publisherChangeNote: keyChangeNote(change, via),
  };
}

/** A forward update as the owner approved it: the plan, and what its approval showed of it. */
interface ApprovedUpdatePlan {
  readonly plan: UpdatePlan;
  readonly shown: readonly ShownAddedPackage[];
  readonly requirements: readonly ConnectorRequirementStatus[];
}

/**
 * Every package the plan adds, as the approval shows it, from the resolver's VERIFIED manifest.
 * A package to be installed with no verified manifest refuses the update here, before the owner
 * is asked: the approval never understates what is installed (spec § 4).
 */
function shownAddedPackages(plan: UpdatePlan): ShownAddedPackage[] {
  return plan.addedPackages.map((added) => {
    const verified = plan.resolver.verified(added.id, added.version);
    if (verified === undefined) {
      throw new RegistryError(
        "ERR_REGISTRY_INSTALL_REFUSED",
        `${added.id}@${added.version} would be installed but has no verified manifest to show in the approval`,
      );
    }
    const { manifest } = verified;
    const pc = verified.publisherChange;
    return {
      id: added.id,
      version: added.version,
      requiredBy: plan.plan.nodes.flatMap((from) =>
        from.deps.filter((d) => d.id === added.id).map((d) => ({ from: from.id, range: d.range })),
      ),
      registry: added.registry,
      registryUrl: added.registryUrl,
      // Fingerprints only, never a `*Key`-named field (the consent display redacts those).
      publisher:
        manifest.publisher === undefined
          ? null
          : {
              id: manifest.publisher.id,
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
      permissions: manifest.permissions,
      newlyInstalled: true,
      kind: isStarterPack(manifest) ? "starter-pack" : "extension",
    };
  });
}

/**
 * Plans a forward update for its approval, or the `update_conflicts` refusal (one line per
 * conflict) when it cannot be planned. Nothing is fetched beyond the verified index and manifests.
 */
async function planForApproval(
  cached: AvailableUpdate,
  deps: AutoUpdateRpcDeps,
): Promise<ApprovedUpdatePlan | UpdateApplyResult> {
  let plan: UpdatePlan;
  let shown: ShownAddedPackage[];
  try {
    plan = await deps.planUpdate(cached);
    shown = shownAddedPackages(plan);
  } catch (e) {
    return {
      applied: false,
      reason: "update_conflicts",
      hint: updateConflictsHint(e),
    };
  }
  let requirements: readonly ConnectorRequirementStatus[] = [];
  try {
    requirements = (await deps.updateRequirements?.(cached, plan)) ?? [];
  } catch {
    // Requirement status never refuses an update: the approval then shows no `Needs:` block.
  }
  return { plan, shown, requirements };
}

/**
 * The approval fields of what a forward update adds: the packages (each once, as the plan text's
 * blocks; the desktop renders the structured list), their permissions together, the connector
 * requirements, and the rendered `planText`. None when the update adds nothing, so such an update
 * is asked exactly as before.
 */
function addedFields(approved: ApprovedUpdatePlan | undefined): Record<string, unknown> {
  if (approved === undefined) return {};
  const { shown, requirements } = approved;
  const union = planPermissionsUnion(shown);
  const planText = withNeedsBlock(
    shown.length === 0 ? undefined : renderUpdatePlan(shown, union),
    requirements,
  );
  return {
    ...(shown.length > 0 && { addedPackages: shown, planPermissions: union }),
    ...(requirements.length > 0 && { connectorRequirements: requirements }),
    ...(planText !== undefined && { planText }),
  };
}

function buildUpdateAction(
  cached: AvailableUpdate,
  isDowngrade: boolean,
  hasRunGrant: boolean,
  badge: VerifiedPublisher | null,
  approved: ApprovedUpdatePlan | undefined,
): PlannedAction {
  return {
    type: isDowngrade ? ACTION_TYPE_DOWNGRADE : ACTION_TYPE_AUTO_UPDATE,
    payload: {
      id: cached.id,
      displayName: cached.displayName,
      fromVersion: cached.fromVersion,
      toVersion: cached.toVersion,
      channel: cached.channel,
      changelog: cached.changelog,
      publisherStatus: cached.publisherStatus,
      // The desktop labels the SIGNATURE from this, never `publisherStatus` as "publisher: verified".
      verificationStatus: cached.verificationStatus,
      addedPermissions: {
        network: cached.permissionDiff.network.added,
        filesystem: {
          read: cached.permissionDiff.filesystem.read.added,
          write: cached.permissionDiff.filesystem.write.added,
        },
      },
      removedPermissions: {
        network: cached.permissionDiff.network.removed,
        filesystem: {
          read: cached.permissionDiff.filesystem.read.removed,
          write: cached.permissionDiff.filesystem.write.removed,
        },
      },
      manifestHash: cached.manifestHash,
      signatureB64: cached.signatureB64,
      // Never `*Key`-named: the executor's prompt redacts such fields (`SENSITIVE_PAYLOAD_KEY`).
      sourceRegistry: cached.sourceRegistry,
      rootFingerprint: cached.rootFingerprint,
      ...(hasRunGrant && {
        runGrantNote:
          cached.toStarterPack === true ? STARTER_PACK_UPDATE_NOTE : runGrantNoteFor(cached.id),
      }),
      // A publisher key change, stated in the prompt (fingerprints only; never `*Key`-named).
      ...publisherChangeFields(cached),
      // A downgrade restores a local previous version, which the update's key does not describe.
      ...(!isDowngrade && { verifiedPublisher: badge, publisherBadge: publisherBadgeText(badge) }),
      ...addedFields(approved),
    },
  };
}

async function resolveUpdateTarget(
  params: Record<string, unknown>,
  deps: AutoUpdateRpcDeps,
): Promise<
  { cached: AvailableUpdate; isDowngrade: boolean; installed: string } | UpdateApplyResult
> {
  const id = typeof params["id"] === "string" ? params["id"] : "";
  const toVersion = typeof params["toVersion"] === "string" ? params["toVersion"] : "";
  if (id === "" || toVersion === "") {
    return { applied: false, reason: "cache_miss" };
  }

  const cached = deps.cache.get(id);
  if (cached?.toVersion !== toVersion) {
    return { applied: false, reason: "cache_miss" };
  }

  const accepted = acceptedKeyFor(params, cached);
  if (cached.verificationStatus === "publisher_key_conflict" && accepted === undefined) {
    return {
      applied: false,
      reason: "publisher_key_conflict",
      hint: `registry ${cached.sourceRegistry} names publisher key ${cached.publisherKeyFingerprint ?? "?"}, which no rotation from a key this gateway trusts and no Nimbus verification vouches for; to apply it anyway, pass --accept-publisher-key ${cached.publisherKeyFingerprint ?? "<fingerprint>"}`,
    };
  }
  if (cached.verificationStatus === "signature_failed") {
    return { applied: false, reason: "signature_failed" };
  }

  const installed = await deps.getInstalledVersion(id);
  if (installed === null) {
    return { applied: false, reason: "cache_miss" };
  }
  if (installed === toVersion) {
    return { applied: false, reason: "same_version" };
  }

  const isDowngrade = isStringSemverLess(toVersion, installed);
  // A forward update detected from another version than the one installed now would roll back to
  // the wrong `prev/<fromVersion>`: refused before the owner is asked (and again under the mutex).
  if (!isDowngrade && installed !== cached.fromVersion) {
    return { applied: false, reason: "cache_miss" };
  }
  // A forward update comes only from its source registry (spec § 8.3): one removed or re-pinned
  // since detection offers nothing, and saying so is clearer than a later signature failure.
  if (!isDowngrade && deps.isSourceCurrent !== undefined && !(await deps.isSourceCurrent(cached))) {
    return {
      applied: false,
      reason: "source_registry_changed",
      hint: `source registry ${cached.sourceRegistry} was removed or re-pinned since this update was detected`,
    };
  }
  if (isDowngrade) {
    const ok = await deps.hasPrevVersion(id, toVersion);
    if (!ok) {
      return { applied: false, reason: "downgrade_unavailable" };
    }
  }
  return {
    cached: accepted === undefined ? cached : { ...cached, acceptedPublisherKey: accepted },
    isDowngrade,
    installed,
  };
}

/**
 * `--accept-publisher-key`: the exact fingerprint of the key the cached update names, or nothing.
 * A different value is refused outright, never read as acceptance of whatever key the index names.
 */
function acceptedKeyFor(
  params: Record<string, unknown>,
  cached: AvailableUpdate,
): string | undefined {
  const v = params["acceptPublisherKey"];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v !== cached.publisherKeyFingerprint) {
    throw new Error(
      `--accept-publisher-key must name the key this update is signed with (${cached.publisherKeyFingerprint ?? "unknown"}); nothing was accepted`,
    );
  }
  // Only an unvouched change needs (or records) the owner's acceptance: a rotation- or
  // Nimbus-vouched one keeps saying what vouched for it.
  return cached.verificationStatus === "publisher_key_conflict" ? v : undefined;
}

/**
 * Whether what the approval was planned against moved before the mutex was taken: the extension
 * is no longer at the version it had when the owner was asked or at the update's `fromVersion`, a
 * package the plan adds has been installed since, or an installed package the plan relies on was
 * removed or is now at another version. Each way the approved plan no longer describes the apply.
 */
async function movedSinceApproval(
  cached: AvailableUpdate,
  installedAtGate: string,
  approved: ApprovedUpdatePlan,
  deps: AutoUpdateRpcDeps,
): Promise<boolean> {
  const installed = await deps.getInstalledVersion(cached.id);
  if (installed !== installedAtGate || installed !== cached.fromVersion) return true;
  for (const added of approved.plan.addedPackages) {
    if ((await deps.getInstalledVersion(added.id)) !== null) return true; // NOSONAR S9382: a few reads, in plan order
  }
  const reliedOn = approved.plan.plan.nodes.filter((n) => !n.newlyInstalled && n.id !== cached.id);
  for (const node of reliedOn) {
    if ((await deps.getInstalledVersion(node.id)) !== node.version) return true; // NOSONAR S9382: a few reads, in plan order
  }
  return false;
}

/**
 * The applied result: what the approved plan added and the requirements the approval showed, and
 * the dependencies the update or downgrade left orphaned.
 */
function appliedResult(
  cached: AvailableUpdate,
  approved: ApprovedUpdatePlan | undefined,
  orphaned: readonly string[] = [],
  grantDropped = false,
): UpdateApplyResult {
  const shown = approved?.shown ?? [];
  const requirements = approved?.requirements ?? [];
  return {
    applied: true,
    jobId: cached.manifestHash.slice(0, 16),
    ...(shown.length > 0 && {
      addedPackages: shown.map((p) => ({
        id: p.id,
        version: p.version,
        registry: p.registry,
        kind: p.kind,
      })),
    }),
    ...(requirements.length > 0 && { connectorRequirements: requirements }),
    ...(orphaned.length > 0 && { orphanedDependencies: [...orphaned] }),
    ...(grantDropped && { grantDropped: true }),
    ...(cached.toStarterPack === true &&
      approved !== undefined && { rootKind: "starter-pack" as const }),
  };
}

/** `approved` is the forward update's plan; undefined exactly for a downgrade. */
async function applyUpdateUnderMutex(
  cached: AvailableUpdate,
  installedAtGate: string,
  approved: ApprovedUpdatePlan | undefined,
  hadRunGrant: boolean,
  deps: AutoUpdateRpcDeps,
): Promise<UpdateApplyResult> {
  const isDowngrade = approved === undefined;
  if (mutex.has(cached.id)) {
    return { applied: false, reason: "update_in_flight" };
  }
  let releaseMutex: () => void = () => {};
  const slot = new Promise<void>((res) => {
    releaseMutex = res;
  });
  mutex.set(cached.id, slot);
  try {
    if (
      approved !== undefined &&
      (await movedSinceApproval(cached, installedAtGate, approved, deps))
    ) {
      // The owner re-runs the update, and is asked about the plan as it now stands.
      return { applied: false, reason: "cache_miss" };
    }
    let orphaned: readonly string[] = [];
    if (approved === undefined) {
      ({ orphanedDependencies: orphaned } = await deps.performDowngrade(cached));
      await deps.appendAudit("extension.downgrade.applied", {
        id: cached.id,
        fromVersion: cached.fromVersion,
        toVersion: cached.toVersion,
      });
    } else {
      ({ orphanedDependencies: orphaned } = await deps.performUpgrade(cached, approved.plan));
      await deps.appendAudit("extension.autoUpdate.applied", {
        id: cached.id,
        fromVersion: cached.fromVersion,
        toVersion: cached.toVersion,
        channel: cached.channel,
      });
    }
    deps.cache.remove(cached.id);
    return appliedResult(cached, approved, orphaned, !isDowngrade && hadRunGrant);
  } catch (e) {
    const phase = e instanceof Error ? extractPhase(e.message) : "internal_error";
    await deps.appendAudit(
      isDowngrade ? "extension.downgrade.failed" : "extension.autoUpdate.failed",
      {
        id: cached.id,
        fromVersion: cached.fromVersion,
        toVersion: cached.toVersion,
        phase,
        message: e instanceof Error ? e.message : String(e),
      },
    );
    // The owner sees the phase the audit row records (a tampered package is `sha256_mismatch`).
    return { applied: false, reason: phase };
  } finally {
    mutex.delete(cached.id);
    releaseMutex();
  }
}

async function handleExtensionUpdate(
  params: Record<string, unknown>,
  deps: AutoUpdateRpcDeps,
): Promise<UpdateApplyResult> {
  const target = await resolveUpdateTarget(params, deps);
  if (!("cached" in target)) {
    return target;
  }
  const { cached, isDowngrade, installed } = target;

  // A forward update is planned BEFORE the owner is asked, so the approval lists every package it
  // adds (spec § 4); the same plan is what the apply gets. A downgrade installs nothing new.
  let approved: ApprovedUpdatePlan | undefined;
  if (!isDowngrade) {
    const planned = await planForApproval(cached, deps);
    if ("applied" in planned) return planned;
    approved = planned;
  }

  const hasRunGrant = (await deps.hasRunGrant?.(cached.id)) === true;
  const gateResult = await deps.gate(
    buildUpdateAction(cached, isDowngrade, hasRunGrant, updateBadge(cached, deps), approved),
  );
  if (gateResult !== "proceed") {
    return { applied: false, reason: "user_rejected" };
  }

  return applyUpdateUnderMutex(cached, installed, approved, hasRunGrant, deps);
}

export async function dispatchAutoUpdateRpc(
  method: string,
  params: Record<string, unknown>,
  deps: AutoUpdateRpcDeps,
): Promise<unknown> {
  if (method === "extension.checkForUpdates") {
    if (params["force"] === true) {
      await deps.forcePoll();
    }
    return deps.cache.list().map((u) => ({ ...u, verifiedPublisher: updateBadge(u, deps) }));
  }

  if (method === "extension.update") {
    return handleExtensionUpdate(params, deps);
  }

  throw new Error(`unknown method: ${method}`);
}

export class InvalidVersionFormat extends Error {
  constructor(version: string) {
    super(`unsupported version format: ${version} (expected strict SemVer 2.0.0)`);
    this.name = "InvalidVersionFormat";
  }
}

/** The index's own strict SemVer 2.0.0 rule (`@nimbus-dev/registry-format`), prerelease tags included. */
export function assertStrictSemver(v: string): void {
  if (!isValidSemver(v)) throw new InvalidVersionFormat(v);
}

/** SemVer 2.0.0 precedence, so `1.1.0-beta.1` < `1.1.0` and a prerelease can be updated to or from. */
function isStringSemverLess(a: string, b: string): boolean {
  assertStrictSemver(a);
  assertStrictSemver(b);
  return Bun.semver.order(a, b) < 0;
}

function extractPhase(message: string): AutoUpdateFailPhase | "internal_error" {
  // First: a block's message quotes the statement's reason, which could contain any other word.
  if (message.startsWith("trust_blocked")) return "trust_blocked";
  if (message.startsWith("update_conflicts")) return "update_conflicts";
  if (message.includes("source_registry_changed")) return "source_registry_changed";
  if (message.includes("sha256_mismatch")) return "sha256_mismatch";
  if (message.includes("package_hash_mismatch")) return "package_hash_mismatch";
  // An unreadable package is not a readable one with a wrong hash, so it gets its own phase.
  if (message.includes("package_hash_unreadable")) return "package_hash_unreadable";
  if (message.includes("signature_failed")) return "signature_failed";
  if (message.includes("swap_failed")) return "swap_failed";
  if (message.includes("downgrade_unavailable")) return "downgrade_unavailable";
  if (message.includes("download")) return "download_failed";
  if (message.includes("extract")) return "extract_failed";
  return "internal_error";
}

export function _resetAutoUpdateMutexForTests(): void {
  mutex.clear();
}
