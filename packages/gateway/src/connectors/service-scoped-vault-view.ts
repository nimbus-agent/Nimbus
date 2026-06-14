import type { NimbusVault } from "../vault/nimbus-vault.ts";

/**
 * A READ-ONLY view of the OS Vault scoped to a single connector service's keyspace (`<service>.*`).
 * Used by the unified spawn-based PERSONAL sync so the bundle spawner builds exactly one server
 * (mirrors how a team-vault view exposes only one entry's keys). Writes are refused — a sync spawn
 * never mutates the vault.
 */
export function createServiceScopedVaultView(
  underlying: NimbusVault,
  service: string,
): NimbusVault {
  const prefix = `${service}.`;
  const readOnly = (op: string): Promise<never> =>
    Promise.reject(
      new Error(`service-scoped vault view is read-only (no ${op} during sync spawn)`),
    );
  return {
    get(key: string): Promise<string | null> {
      return key.startsWith(prefix) ? underlying.get(key) : Promise.resolve(null);
    },
    set(_key: string, _value: string): Promise<void> {
      return readOnly("writes");
    },
    delete(_key: string): Promise<void> {
      return readOnly("deletes");
    },
    async listKeys(listPrefix?: string): Promise<string[]> {
      const full = listPrefix === undefined ? prefix : `${prefix}${listPrefix}`;
      const keys = await underlying.listKeys(full);
      return keys.filter((k) => k.startsWith(prefix));
    },
  };
}
