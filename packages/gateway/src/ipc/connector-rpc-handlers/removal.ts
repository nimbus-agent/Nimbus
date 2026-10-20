import type { Database } from "bun:sqlite";
import {
  type ConnectorServiceId,
  GOOGLE_CONNECTOR_SERVICES,
  MICROSOFT_CONNECTOR_SERVICES,
  normalizeConnectorServiceId,
} from "../../connectors/connector-catalog.ts";
import { clearConnectorVaultSecretKeys } from "../../connectors/connector-secrets-manifest.ts";
import {
  ALL_GOOGLE_OAUTH_VAULT_KEYS,
  clearOAuthVaultIfProviderUnused,
  sharedOAuthKey,
} from "../../connectors/connector-vault.ts";
import { extensionIdBackingServiceId } from "../../connectors/extension-sync/extension-identity.ts";
import {
  clearRemoveIntent,
  getPendingRemoveIntents,
  writeRemoveIntent,
} from "../../connectors/remove-intent.ts";
import {
  deleteUserMcpConnector,
  USER_MCP_SERVICE_ID_PATTERN,
} from "../../connectors/user-mcp-store.ts";
import type { LocalIndex } from "../../index/local-index.ts";
import type { SyncScheduler } from "../../sync/scheduler.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import {
  ConnectorRpcError,
  requireRegisteredSchedulerServiceId,
  sumItemsSiblingServices,
} from "../connector-rpc-shared.ts";
import type { ConnectorRpcHandlerContext, ConnectorRpcHit } from "./context.ts";

async function snapshotGoogleOAuthIfLastFamilyMember(
  vault: NimbusVault,
  db: Database,
  normalizedForFamily: ConnectorServiceId | null,
): Promise<Record<string, string> | null> {
  if (
    normalizedForFamily === null ||
    !GOOGLE_CONNECTOR_SERVICES.has(normalizedForFamily) ||
    sumItemsSiblingServices(db, normalizedForFamily, GOOGLE_CONNECTOR_SERVICES) !== 0
  ) {
    return null;
  }
  // Independent per-key lookups over a short fixed key list, so they run concurrently; `snap` is
  // still filled in key order.
  const entries = await Promise.all(
    ALL_GOOGLE_OAUTH_VAULT_KEYS.map(async (k) => [k, await vault.get(k)] as const),
  );
  const snap: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (v !== null && v !== "") {
      snap[k] = v;
    }
  }
  return Object.keys(snap).length > 0 ? snap : null;
}

async function snapshotMicrosoftOAuthIfLastFamilyMember(
  vault: NimbusVault,
  db: Database,
  normalizedForFamily: ConnectorServiceId | null,
): Promise<string | null> {
  if (
    normalizedForFamily === null ||
    !MICROSOFT_CONNECTOR_SERVICES.has(normalizedForFamily) ||
    sumItemsSiblingServices(db, normalizedForFamily, MICROSOFT_CONNECTOR_SERVICES) !== 0
  ) {
    return null;
  }
  return await vault.get(sharedOAuthKey("microsoft"));
}

function unregisterConnectorFromSyncScheduler(
  syncScheduler: SyncScheduler | undefined,
  id: string,
): void {
  if (syncScheduler === undefined) {
    return;
  }
  if (id === "github") {
    syncScheduler.unregister("github_actions");
  }
  syncScheduler.unregister(id);
}

function removeConnectorIndexEntries(localIndex: LocalIndex, id: string): number {
  let itemsDeleted = 0;
  if (id === "github") {
    itemsDeleted += localIndex.removeConnectorIndexData("github_actions");
  }
  itemsDeleted += localIndex.removeConnectorIndexData(id);
  return itemsDeleted;
}

async function restoreGoogleAndMicrosoftOAuthBackups(
  vault: NimbusVault,
  googleOAuthBackup: Record<string, string> | null,
  microsoftOAuthBackup: string | null,
): Promise<void> {
  if (googleOAuthBackup !== null) {
    for (const [k, v] of Object.entries(googleOAuthBackup)) {
      await vault.set(k, v); // NOSONAR S9382: sequential by design - the macOS vault's set() read-modify-writes one shared key index, so concurrent restores would drop entries
    }
  }
  if (microsoftOAuthBackup !== null) {
    await vault.set(sharedOAuthKey("microsoft"), microsoftOAuthBackup);
  }
}

/**
 * Plan decision 7: an extension-backed id has ONE removal path, `extension remove`, which also stops
 * the mesh slot and drops the grant; clearing only the index here would leave both alive. Returns
 * the refusal for `id`, or `undefined` when no extension backs it.
 */
function extensionBackedRefusal(
  ctx: ConnectorRpcHandlerContext,
  id: string,
): ConnectorRpcError | undefined {
  const db = ctx.localIndex.getDatabase();
  const backing = ctx.extensionBackingId ?? ((s: string) => extensionIdBackingServiceId(db, s));
  const extensionId = backing(id);
  if (extensionId === undefined) return undefined;
  return new ConnectorRpcError(
    -32602,
    `ERR_CONNECTOR_IS_EXTENSION: ${id} is synced by the extension ${extensionId}; remove it with \`nimbus extension remove ${extensionId}\` (connector pause, resume and sync still work)`,
  );
}

/**
 * Asked by the router BEFORE the owner HITL gate, so an extension-backed removal is refused with no
 * prompt and no "approved" audit row for a removal that never ran. An id that does not resolve is
 * left for the handler to refuse after the gate, exactly as before.
 */
export function refuseExtensionBackedRemoval(ctx: ConnectorRpcHandlerContext): void {
  let id: string;
  try {
    id = requireRegisteredSchedulerServiceId(ctx.rec, ctx.localIndex);
  } catch {
    return;
  }
  const refusal = extensionBackedRefusal(ctx, id);
  if (refusal !== undefined) throw refusal;
}

export async function handleConnectorRemove(
  ctx: ConnectorRpcHandlerContext,
): Promise<ConnectorRpcHit> {
  const { rec, vault, localIndex, syncScheduler } = ctx;
  const id = requireRegisteredSchedulerServiceId(rec, localIndex);
  const db = localIndex.getDatabase();

  // Backstop for a caller that reaches the handler without the router's pre-gate check.
  const refusal = extensionBackedRefusal(ctx, id);
  if (refusal !== undefined) throw refusal;

  writeRemoveIntent(db, id);

  const normalizedForFamily = normalizeConnectorServiceId(id);
  const [googleOAuthBackup, microsoftOAuthBackup] = await Promise.all([
    snapshotGoogleOAuthIfLastFamilyMember(vault, db, normalizedForFamily),
    snapshotMicrosoftOAuthIfLastFamilyMember(vault, db, normalizedForFamily),
  ]);

  unregisterConnectorFromSyncScheduler(syncScheduler, id);
  deleteUserMcpConnector(db, id);
  if (ctx.connectorMesh !== undefined && USER_MCP_SERVICE_ID_PATTERN.test(id)) {
    // Stops the child and deletes its sandbox leaf; never throws (a locked leaf is logged).
    await ctx.connectorMesh.removeUserMcpSandbox(id);
  }
  const itemsDeleted = removeConnectorIndexEntries(localIndex, id);

  let vaultKeys: string[] = [];
  try {
    vaultKeys = await clearOAuthVaultIfProviderUnused(vault, db, id);
    const normalizedBuiltin = normalizeConnectorServiceId(id);
    if (normalizedBuiltin !== null) {
      vaultKeys.push(...(await clearConnectorVaultSecretKeys(vault, normalizedBuiltin)));
    }
  } catch (removeErr) {
    await restoreGoogleAndMicrosoftOAuthBackups(vault, googleOAuthBackup, microsoftOAuthBackup);
    throw removeErr;
  }

  clearRemoveIntent(db, id);

  return { kind: "hit", value: { ok: true, itemsDeleted, vaultKeysRemoved: vaultKeys } };
}

export async function resumePendingRemovals(
  vault: NimbusVault,
  localIndex: LocalIndex,
): Promise<string[]> {
  const db = localIndex.getDatabase();
  const pending = getPendingRemoveIntents(db);
  const completed: string[] = [];
  for (const serviceId of pending) {
    try {
      localIndex.removeConnectorIndexData(serviceId);
      await clearOAuthVaultIfProviderUnused(vault, db, serviceId); // NOSONAR S9382: sequential by design - the provider-unused check counts index rows that the previous pending removal just deleted
      const normalizedBuiltin = normalizeConnectorServiceId(serviceId);
      if (normalizedBuiltin !== null) {
        await clearConnectorVaultSecretKeys(vault, normalizedBuiltin); // NOSONAR S9382: sequential by design - each pending removal completes (index, OAuth, secrets, intent) before the next one's provider-unused check
      }
      clearRemoveIntent(db, serviceId);
      completed.push(serviceId);
    } catch {
      // Leave the intent intact — will retry on next startup.
    }
  }
  return completed;
}
