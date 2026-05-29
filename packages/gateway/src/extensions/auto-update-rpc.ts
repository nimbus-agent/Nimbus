import type { AutoUpdateCache } from "./auto-update-cache.ts";
import {
  ACTION_TYPE_AUTO_UPDATE,
  ACTION_TYPE_DOWNGRADE,
  type AvailableUpdate,
  type UpdateApplyResult,
} from "./auto-update-types.ts";

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
}

const mutex = new Map<string, Promise<void>>();

function buildUpdateAction(cached: AvailableUpdate, isDowngrade: boolean): PlannedAction {
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
  if (cached === undefined || cached.toVersion !== toVersion) {
    return { applied: false, reason: "cache_miss" };
  }

  if (cached.verificationStatus === "needs_sync") {
    return {
      applied: false,
      reason: "publisher_key_missing",
      hint: "run `nimbus extension sync` to fetch the rotated publisher key",
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
  if (isDowngrade) {
    const ok = await deps.hasPrevVersion(id, toVersion);
    if (!ok) {
      return { applied: false, reason: "downgrade_unavailable" };
    }
  }
  return { cached, isDowngrade };
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
    return { applied: false, reason: "internal_error" };
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

  const gateResult = await deps.gate(buildUpdateAction(cached, isDowngrade));
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

const STRICT_SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export class InvalidVersionFormat extends Error {
  constructor(version: string) {
    super(`unsupported version format: ${version} (expected strict x.y.z, no pre-release tags)`);
    this.name = "InvalidVersionFormat";
  }
}

export function assertStrictSemver(v: string): void {
  if (!STRICT_SEMVER_RE.test(v)) throw new InvalidVersionFormat(v);
}

function isStringSemverLess(a: string, b: string): boolean {
  assertStrictSemver(a);
  assertStrictSemver(b);
  const pa = a.split(".").map((s) => Number.parseInt(s, 10));
  const pb = b.split(".").map((s) => Number.parseInt(s, 10));
  for (let i = 0; i < 3; i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (ai < bi) return true;
    if (ai > bi) return false;
  }
  return false;
}

function extractPhase(message: string): string {
  if (message.includes("sha256_mismatch")) return "sha256_mismatch";
  if (message.includes("signature_failed")) return "signature_failed";
  if (message.includes("swap_failed")) return "swap_failed";
  if (message.includes("download")) return "download_failed";
  if (message.includes("extract")) return "extract_failed";
  return "internal_error";
}

export function _resetAutoUpdateMutexForTests(): void {
  mutex.clear();
}
