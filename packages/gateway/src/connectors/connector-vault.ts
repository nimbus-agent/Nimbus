import type { Database } from "bun:sqlite";

import { countItemsForAnyService } from "../sync/scheduler-store.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import {
  type ConnectorServiceId,
  GOOGLE_CONNECTOR_SERVICES,
  MICROSOFT_CONNECTOR_SERVICES,
} from "./connector-catalog.ts";
import type { CONNECTOR_VAULT_SECRET_KEYS } from "./connector-secrets-manifest.ts";

const GOOGLE_SERVICES = [...GOOGLE_CONNECTOR_SERVICES];
const MICROSOFT_SERVICES = [...MICROSOFT_CONNECTOR_SERVICES];

const GOOGLE_SERVICE_VAULT_KEYS: Partial<Record<ConnectorServiceId, string>> = {
  google_drive: "google_drive.oauth",
  gmail: "google_gmail.oauth",
  google_photos: "google_photos.oauth",
};

export const ALL_GOOGLE_OAUTH_VAULT_KEYS: readonly string[] = [
  "google.oauth",
  "google_drive.oauth",
  "google_gmail.oauth",
  "google_photos.oauth",
];

const MICROSOFT_SERVICE_VAULT_KEYS: Partial<Record<ConnectorServiceId, string>> = {
  onedrive: "onedrive.oauth",
  outlook: "outlook.oauth",
  teams: "teams.oauth",
};

export function perServiceOAuthVaultKey(serviceId: ConnectorServiceId): string | undefined {
  return GOOGLE_SERVICE_VAULT_KEYS[serviceId] ?? MICROSOFT_SERVICE_VAULT_KEYS[serviceId];
}

export async function writePerServiceOAuthKey(
  vault: NimbusVault,
  serviceId: ConnectorServiceId,
  sharedKey: string,
): Promise<void> {
  const key = perServiceOAuthVaultKey(serviceId);
  if (key === undefined) return;
  const payload = await vault.get(sharedKey);
  if (payload === null || payload === "") return;
  await vault.set(key, payload);
}

export async function migrateToPerServiceOAuthKeys(vault: NimbusVault): Promise<void> {
  const msShared = await vault.get("microsoft.oauth");
  if (msShared !== null && msShared !== "") {
    for (const key of Object.values(MICROSOFT_SERVICE_VAULT_KEYS)) {
      const existing = await vault.get(key);
      if (existing === null || existing === "") {
        await vault.set(key, msShared);
      }
    }
  }
}

export async function clearOAuthVaultIfProviderUnused(
  vault: NimbusVault,
  db: Database,
  removedServiceId: string,
): Promise<string[]> {
  const cleared: string[] = [];
  if (GOOGLE_CONNECTOR_SERVICES.has(removedServiceId)) {
    if (countItemsForAnyService(db, GOOGLE_SERVICES) === 0) {
      await vault.delete("google.oauth");
      cleared.push("google.oauth");
      for (const key of Object.values(GOOGLE_SERVICE_VAULT_KEYS)) {
        await vault.delete(key);
        cleared.push(key);
      }
    }
  }
  if (MICROSOFT_CONNECTOR_SERVICES.has(removedServiceId)) {
    if (countItemsForAnyService(db, MICROSOFT_SERVICES) === 0) {
      await vault.delete("microsoft.oauth");
      cleared.push("microsoft.oauth");
      for (const key of Object.values(MICROSOFT_SERVICE_VAULT_KEYS)) {
        await vault.delete(key);
        cleared.push(key);
      }
    }
  }
  return cleared;
}

export type ConnectorSecretKeyOf<S extends ConnectorServiceId> = [
  (typeof CONNECTOR_VAULT_SECRET_KEYS)[S][number],
] extends [never]
  ? never
  : (typeof CONNECTOR_VAULT_SECRET_KEYS)[S][number] extends `${S}.${infer K}`
    ? K
    : never;

export async function readConnectorSecret<S extends ConnectorServiceId>(
  vault: NimbusVault,
  serviceId: S,
  keyName: ConnectorSecretKeyOf<S>,
): Promise<string | null> {
  const fullKey = `${serviceId}.${keyName}`;
  return vault.get(fullKey);
}

export async function writeConnectorSecret<S extends ConnectorServiceId>(
  vault: NimbusVault,
  serviceId: S,
  keyName: ConnectorSecretKeyOf<S>,
  value: string,
): Promise<void> {
  const fullKey = `${serviceId}.${keyName}`;
  return vault.set(fullKey, value);
}

export async function deleteConnectorSecret<S extends ConnectorServiceId>(
  vault: NimbusVault,
  serviceId: S,
  keyName: ConnectorSecretKeyOf<S>,
): Promise<void> {
  const fullKey = `${serviceId}.${keyName}`;
  return vault.delete(fullKey);
}

export type SharedOAuthProvider = "google" | "microsoft";

export function sharedOAuthKey(provider: SharedOAuthProvider): `${SharedOAuthProvider}.oauth` {
  return `${provider}.oauth`;
}
