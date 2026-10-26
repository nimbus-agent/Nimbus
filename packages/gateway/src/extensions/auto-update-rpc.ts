import { isValidSemver } from "@nimbus-dev/registry-format";
import type { AutoUpdateCache } from "./auto-update-cache.ts";
import {
  ACTION_TYPE_AUTO_UPDATE,
  ACTION_TYPE_DOWNGRADE,
  type AutoUpdateFailPhase,
  type AvailableUpdate,
  type UpdateApplyResult,
} from "./auto-update-types.ts";
import { keyChangeNote } from "./trust/publisher-key-decision.ts";

interface PlannedAction {
  type: typeof ACTION_TYPE_AUTO_UPDATE | typeof ACTION_TYPE_DOWNGRADE;
  payload: Record<string, unknown>;
}

type GateResult = "proceed" | { status: "rejected" };

export interface AutoUpdateRpcDeps {
  cache: AutoUpdateCache;
  forcePoll: () => Promise<void>;
  gate: (action: PlannedAction) => Promise<GateResult>;
  performUpgrade: (cached: AvailableUpdate) => Promise<void>;
  performDowngrade: (cached: AvailableUpdate) => Promise<void>;
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
}

const mutex = new Map<string, Promise<void>>();

/** The consent note an update shows when it will leave the extension's run grant stale. */
export function runGrantNoteFor(id: string): string {
  return `Running the new version will need a new \`nimbus extension approve ${id}\`.`;
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

function buildUpdateAction(
  cached: AvailableUpdate,
  isDowngrade: boolean,
  hasRunGrant: boolean,
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
      ...(hasRunGrant && { runGrantNote: runGrantNoteFor(cached.id) }),
      // A publisher key change, stated in the prompt (fingerprints only; never `*Key`-named).
      ...publisherChangeFields(cached),
    },
  };
}

async function resolveUpdateTarget(
  params: Record<string, unknown>,
  deps: AutoUpdateRpcDeps,
): Promise<{ cached: AvailableUpdate; isDowngrade: boolean } | UpdateApplyResult> {
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
  return v;
}

async function applyUpdateUnderMutex(
  cached: AvailableUpdate,
  isDowngrade: boolean,
  deps: AutoUpdateRpcDeps,
): Promise<UpdateApplyResult> {
  if (mutex.has(cached.id)) {
    return { applied: false, reason: "update_in_flight" };
  }
  let releaseMutex: () => void = () => {};
  const slot = new Promise<void>((res) => {
    releaseMutex = res;
  });
  mutex.set(cached.id, slot);
  try {
    if (isDowngrade) {
      await deps.performDowngrade(cached);
      await deps.appendAudit("extension.downgrade.applied", {
        id: cached.id,
        fromVersion: cached.fromVersion,
        toVersion: cached.toVersion,
      });
    } else {
      await deps.performUpgrade(cached);
      await deps.appendAudit("extension.autoUpdate.applied", {
        id: cached.id,
        fromVersion: cached.fromVersion,
        toVersion: cached.toVersion,
        channel: cached.channel,
      });
    }
    deps.cache.remove(cached.id);
    return {
      applied: true,
      jobId: cached.manifestHash.slice(0, 16),
    };
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
  const { cached, isDowngrade } = target;

  const hasRunGrant = (await deps.hasRunGrant?.(cached.id)) === true;
  const gateResult = await deps.gate(buildUpdateAction(cached, isDowngrade, hasRunGrant));
  if (gateResult !== "proceed") {
    return { applied: false, reason: "user_rejected" };
  }

  return applyUpdateUnderMutex(cached, isDowngrade, deps);
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
    return deps.cache.list();
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
