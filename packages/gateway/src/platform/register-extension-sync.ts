import type { Database } from "bun:sqlite";
import type { Logger } from "pino";

import { type ExtensionRow, listExtensions } from "../automation/extension-store.ts";
import {
  type ExtensionIdentity,
  type ExtensionManifestReader,
  readInstalledManifest,
  resolveExtensionIdentity,
} from "../connectors/extension-sync/extension-identity.ts";
import {
  createExtensionSyncable,
  EXTENSION_SYNC_BUDGET,
} from "../connectors/extension-sync/extension-syncable.ts";
import { getConnectorHealth } from "../connectors/health.ts";
import type { LazyConnectorMesh } from "../connectors/lazy-mesh/index.ts";
import {
  bindingInputFor,
  CONTINUITY_TABLE,
  type ContinuityEntry,
  findContinuityBinding,
} from "../extensions/continuity/continuity-table.ts";
import { parseRunCredentials } from "../extensions/extension-credential-set.ts";
import {
  credentialsConfigured,
  resolveRunCredentials,
} from "../extensions/extension-credentials.ts";
import { parseRunGrants } from "../extensions/extension-run-grants.ts";
import { extensionSpawnPolicyForGrants } from "../extensions/extension-runtime.ts";
import { deriveExtensionServiceId } from "../extensions/extension-service-id.ts";
import type { ExtensionManifest } from "../extensions/manifest.ts";
import {
  type ExtensionRunGrantRow,
  getRunGrant,
  listRunGrants,
} from "../extensions/run-grant-store.ts";
import type { LocalIndex } from "../index/local-index.ts";
import type { SyncScheduler } from "../sync/scheduler.ts";
import type { Syncable } from "../sync/types.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import type { SandboxRunner } from "./sandbox/sandbox-runner.ts";

/**
 * Keeps the scheduler's set of extension syncables equal to what the database says may sync
 * (spec § 8.3): an ENABLED extension with a LIVE (non-stale) run grant whose installed manifest
 * declares a `sync` block, registered under its INDEX id (`readwise` when the continuity table binds
 * it, else its `ext_` id). Everything else is unregistered; items are never touched here — only
 * `extension remove` purges them ({@link purgeExtensionIndexData}).
 */
export interface ExtensionSyncRegistrar {
  /** Boot: registers every extension that may sync. A stale grant is skipped, not re-paused. */
  registerAllFromDatabase(): void;
  /** (Re)register when an enabled, live grant with a sync block exists; otherwise unregister. */
  refresh(extensionId: string): void;
  /** Unregisters unconditionally — `extension remove` calls it before the row and grant go. */
  unregister(extensionId: string): void;
}

/** What the registrar needs of the scheduler. `register` is the policy-filtered one (I22). */
export type ExtensionSyncScheduler = Pick<
  SyncScheduler,
  "register" | "unregister" | "pause" | "resume" | "syncableFor"
>;

export interface ExtensionSyncRegistrarDeps {
  readonly db: Database;
  readonly vault: NimbusVault;
  readonly scheduler: ExtensionSyncScheduler;
  readonly mesh: Pick<LazyConnectorMesh, "callExtensionSyncTool">;
  readonly sandbox: Pick<SandboxRunner, "canConfine">;
  /** A thunk, so the runtime's read paths are recomputed for every preflight. */
  readonly runtimeReadPaths: () => readonly string[];
  readonly table?: readonly ContinuityEntry[];
  /** Test seam; production reads the hash-checked manifest of the installed tree. */
  readonly readManifest?: ExtensionManifestReader;
  readonly logger?: Pick<Logger, "warn">;
}

/** The owner's way back from a stale-grant pause; matched on resume, so it is one definition. */
function reapproveSuffix(extensionId: string): string {
  return `run \`nimbus extension approve ${extensionId}\` to resume sync`;
}

/** The paused reason after an applied update (or any change) left the run grant stale. */
export function staleGrantPauseReason(
  extensionId: string,
  row: Pick<ExtensionRow, "version">,
  grant: Pick<ExtensionRunGrantRow, "version">,
): string {
  const what =
    row.version === grant.version ? "changed since it was approved" : `updated to ${row.version}`;
  return `${what} — ${reapproveSuffix(extensionId)}`;
}

type SyncPlan =
  | { readonly kind: "none" }
  | { readonly kind: "stale"; readonly identity: ExtensionIdentity; readonly reason: string }
  | {
      readonly kind: "live";
      readonly identity: ExtensionIdentity;
      readonly sync: NonNullable<ExtensionManifest["sync"]>;
    };

function isStale(row: ExtensionRow, grant: ExtensionRunGrantRow): boolean {
  return row.version !== grant.version || row.tree_digest !== grant.tree_digest;
}

function planFor(deps: ExtensionSyncRegistrarDeps, extensionId: string): SyncPlan {
  const row = listExtensions(deps.db).find((r) => r.id === extensionId);
  const grant = getRunGrant(deps.db, extensionId);
  if (row === undefined || grant === null || row.enabled !== 1) return { kind: "none" };
  const manifest = (deps.readManifest ?? readInstalledManifest)(row);
  if (manifest === undefined) return { kind: "none" };
  const identity = resolveExtensionIdentity(row, manifest, grant, deps.table ?? CONTINUITY_TABLE);
  if (isStale(row, grant)) {
    return { kind: "stale", identity, reason: staleGrantPauseReason(extensionId, row, grant) };
  }
  if (manifest.sync === undefined) return { kind: "none" };
  return { kind: "live", identity, sync: manifest.sync };
}

/** `canConfine` over the policy this extension would spawn with, re-read from its grant each time. */
function canConfineFor(deps: ExtensionSyncRegistrarDeps, extensionId: string): string | null {
  const grant = getRunGrant(deps.db, extensionId);
  if (grant === null) return "the extension no longer has a run approval";
  const grants = parseRunGrants(grant.permissions_json);
  if (grants === undefined) return "the run approval's stored grants are unreadable";
  return deps.sandbox.canConfine(
    extensionSpawnPolicyForGrants(grant.service_id, grants, deps.runtimeReadPaths()),
  );
}

/** Every credential the CURRENT grant carries is non-blank in the Vault (re-read per run). */
async function grantConfigured(
  deps: ExtensionSyncRegistrarDeps,
  extensionId: string,
): Promise<boolean> {
  const grant = getRunGrant(deps.db, extensionId);
  if (grant === null) return false;
  const creds = parseRunCredentials(grant.credentials_json);
  return creds !== undefined && credentialsConfigured(deps.vault, creds);
}

function buildSyncable(
  deps: ExtensionSyncRegistrarDeps,
  identity: ExtensionIdentity,
  sync: NonNullable<ExtensionManifest["sync"]>,
): Syncable {
  return createExtensionSyncable({
    identity,
    intervalMs: sync.intervalSeconds * 1000,
    itemTypes: sync.itemTypes,
    callSync: (req) =>
      deps.mesh.callExtensionSyncTool(
        identity.codeServerId,
        req,
        EXTENSION_SYNC_BUDGET.callTimeoutMs,
      ),
    isConfigured: () => grantConfigured(deps, identity.extensionId),
    canConfine: () => canConfineFor(deps, identity.extensionId),
    budget: { maxPages: EXTENSION_SYNC_BUDGET.maxPages, maxMs: EXTENSION_SYNC_BUDGET.maxMs },
  });
}

export function createExtensionSyncRegistrar(
  deps: ExtensionSyncRegistrarDeps,
): ExtensionSyncRegistrar {
  /** extension id -> what THIS registrar registered, so only its own syncable is ever removed. */
  const registered = new Map<string, { indexServiceId: string; syncable: Syncable }>();

  const unregister = (extensionId: string): void => {
    const mine = registered.get(extensionId);
    if (mine === undefined) return;
    registered.delete(extensionId);
    if (deps.scheduler.syncableFor(mine.indexServiceId) === mine.syncable) {
      deps.scheduler.unregister(mine.indexServiceId);
    }
  };

  const register = (
    identity: ExtensionIdentity,
    sync: NonNullable<ExtensionManifest["sync"]>,
  ): void => {
    unregister(identity.extensionId);
    const indexId = identity.indexServiceId;
    if (deps.scheduler.syncableFor(indexId) !== undefined) {
      // A built-in connector (the bundled `readwise`, until it is deleted) or another extension
      // already syncs under this id. Replacing it would write two sources into one namespace.
      deps.logger?.warn(
        { extensionId: identity.extensionId, serviceId: indexId },
        "extension sync not registered: another syncable already uses this service id",
      );
      return;
    }
    const syncable = buildSyncable(deps, identity, sync);
    deps.scheduler.register(syncable);
    // The policy-filtered registrar drops a blocked id silently; track only what really landed.
    if (deps.scheduler.syncableFor(indexId) !== syncable) return;
    registered.set(identity.extensionId, { indexServiceId: indexId, syncable });
    // The stale-grant pause names re-approval as the way back, so a re-approval honours it. Any
    // other pause (the owner's own, a sandbox preflight) is left for `connector resume`.
    const health = getConnectorHealth(deps.db, indexId);
    if (
      health.state === "paused" &&
      health.lastError?.endsWith(reapproveSuffix(identity.extensionId)) === true
    ) {
      deps.scheduler.resume(indexId);
    }
  };

  const apply = (extensionId: string, pauseStale: boolean): void => {
    const plan = planFor(deps, extensionId);
    if (plan.kind === "live") {
      register(plan.identity, plan.sync);
      return;
    }
    unregister(extensionId);
    if (plan.kind === "stale" && pauseStale) {
      deps.scheduler.pause(plan.identity.indexServiceId, plan.reason);
    }
  };

  return {
    registerAllFromDatabase() {
      for (const grant of listRunGrants(deps.db)) apply(grant.extension_id, false);
    },
    refresh(extensionId) {
      apply(extensionId, true);
    },
    unregister,
  };
}

/** A registrar that registers nothing: the extension runtime is off, or sync is (I41 demo). */
export const NULL_EXTENSION_SYNC_REGISTRAR: ExtensionSyncRegistrar = {
  registerAllFromDatabase() {},
  refresh() {},
  unregister() {},
};

/**
 * The boot-time choice. A demo-rooted gateway (I41) has neither the runtime nor a scheduler that
 * runs, and `[extensions] runtime = false` gives the mesh no slot source to spawn through — in both
 * cases nothing is registered, so no extension sync can ever be attempted.
 */
export function createExtensionSyncRegistrarForBoot(
  opts: { readonly runtimeEnabled: boolean; readonly syncEnabled: boolean },
  deps: ExtensionSyncRegistrarDeps,
): ExtensionSyncRegistrar {
  return opts.runtimeEnabled && opts.syncEnabled
    ? createExtensionSyncRegistrar(deps)
    : NULL_EXTENSION_SYNC_REGISTRAR;
}

export interface ExtensionIndexPurgeDeps {
  readonly db: Database;
  readonly vault: NimbusVault;
  readonly localIndex: Pick<LocalIndex, "removeConnectorIndexData">;
  readonly table?: readonly ContinuityEntry[];
  readonly readManifest?: ExtensionManifestReader;
}

export interface ExtensionIndexPurgeResult {
  readonly indexServiceId: string | undefined;
  readonly itemsDeleted: number;
  readonly vaultKeysRemoved: readonly string[];
}

/**
 * `extension remove`'s purge (spec § 8.3, plan decision 7), run BEFORE the row and grant are
 * deleted, since both are needed to know where the extension wrote. Purges, under the INDEX id,
 * every item, the scheduler and sync-state rows (`removeConnectorIndexData`) and the health row; and
 * deletes every credential key the extension was granted or would be granted — for a bound extension
 * that includes the legacy key (`readwise.token`), exactly as `connector remove readwise` would.
 *
 * With no grant (revoked earlier) the code-server id is the derived one, so items an earlier sync
 * wrote under it still go. A manifest that cannot be read loses the binding, so a bound extension's
 * legacy namespace is then NOT purged — the stated bound of reading identity from the install tree.
 */
export async function purgeExtensionIndexData(
  deps: ExtensionIndexPurgeDeps,
  extensionId: string,
): Promise<ExtensionIndexPurgeResult> {
  const row = listExtensions(deps.db).find((r) => r.id === extensionId);
  if (row === undefined)
    return { indexServiceId: undefined, itemsDeleted: 0, vaultKeysRemoved: [] };
  const grant = getRunGrant(deps.db, extensionId);
  let codeServerId: string | undefined = grant?.service_id;
  if (codeServerId === undefined) {
    try {
      codeServerId = deriveExtensionServiceId(extensionId);
    } catch {
      codeServerId = undefined;
    }
  }
  const manifest = (deps.readManifest ?? readInstalledManifest)(row);
  const binding =
    manifest === undefined
      ? undefined
      : findContinuityBinding(bindingInputFor(row, manifest), deps.table ?? CONTINUITY_TABLE);
  const indexServiceId = binding?.legacyServiceId ?? codeServerId;
  if (indexServiceId === undefined) {
    return { indexServiceId: undefined, itemsDeleted: 0, vaultKeysRemoved: [] };
  }

  // Items, the scheduler_state row, and the sync_state row — which IS the health row.
  const itemsDeleted = deps.localIndex.removeConnectorIndexData(indexServiceId);

  const keys = new Set<string>();
  const granted = grant === null ? undefined : parseRunCredentials(grant.credentials_json);
  for (const c of Object.values(granted ?? {})) keys.add(c.vaultKey);
  if (manifest !== undefined && codeServerId !== undefined) {
    for (const c of Object.values(resolveRunCredentials(manifest, codeServerId, binding))) {
      keys.add(c.vaultKey);
    }
  }
  const removed: string[] = [];
  for (const key of [...keys].sort((a, b) => (a < b ? -1 : 1))) {
    if ((await deps.vault.get(key)) === null) continue; // NOSONAR S9382: sequential by design - the macOS vault's delete read-modify-writes one shared key index
    await deps.vault.delete(key); // NOSONAR S9382: sequential by design - see above
    removed.push(key);
  }
  return { indexServiceId, itemsDeleted, vaultKeysRemoved: removed };
}
