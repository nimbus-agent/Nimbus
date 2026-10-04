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
import {
  clearRemoveIntent,
  getPendingRemoveIntents,
  writeRemoveIntent,
} from "../../connectors/remove-intent.ts";
import { deleteUserMcpConnector } from "../../connectors/user-mcp-store.ts";
import type { LocalIndex } from "../../index/local-index.ts";
import type { SyncScheduler } from "../../sync/scheduler.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import {
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

export async function handleConnectorRemove(
  ctx: ConnectorRpcHandlerContext,
): Promise<ConnectorRpcHit> {
  const { rec, vault, localIndex, syncScheduler } = ctx;
  const id = requireRegisteredSchedulerServiceId(rec, localIndex);
  const db = localIndex.getDatabase();

  writeRemoveIntent(db, id);

  const normalizedForFamily = normalizeConnectorServiceId(id);
  const [googleOAuthBackup, microsoftOAuthBackup] = await Promise.all([
    snapshotGoogleOAuthIfLastFamilyMember(vault, db, normalizedForFamily),
    snapshotMicrosoftOAuthIfLastFamilyMember(vault, db, normalizedForFamily),
  ]);

  unregisterConnectorFromSyncScheduler(syncScheduler, id);
  deleteUserMcpConnector(db, id);
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
