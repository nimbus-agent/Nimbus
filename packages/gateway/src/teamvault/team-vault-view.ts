import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { TEAM_VAULT_PREFIX, teamVaultKey } from "./team-vault-keys.ts";

/**
 * A READ-ONLY view of the OS Vault scoped to one team entry's keyspace. A connector-key read
 * (`github.pat`, `slack.oauth`, …) is transparently redirected to `teamvault.<entry>.<connectorKey>`,
 * so the EXISTING per-service spawners (which read `readConnectorSecret(vault, …)`) spawn a
 * team-credentialed connector instance with NO per-service duplication.
 *
 * Writes are refused: an ephemeral team-tool spawn must never mutate the vault (the team secret is
 * consumed in-process and discarded; I19). The team secret values live only inside the spawned
 * subprocess env + this view's call scope — never returned to a caller.
 */
export function createTeamVaultView(underlying: NimbusVault, entry: string): NimbusVault {
  const prefix = `${TEAM_VAULT_PREFIX}${entry}.`;
  return {
    get(key: string): Promise<string | null> {
      // Already-namespaced keys pass through unchanged (defensive — spawners use bare connector keys).
      if (key.startsWith(TEAM_VAULT_PREFIX)) return underlying.get(key);
      return underlying.get(teamVaultKey(entry, key));
    },
    set(_key: string, _value: string): Promise<void> {
      return Promise.reject(
        new Error("team-vault-view is read-only (no writes during team spawn)"),
      );
    },
    delete(_key: string): Promise<void> {
      return Promise.reject(
        new Error("team-vault-view is read-only (no deletes during team spawn)"),
      );
    },
    async listKeys(listPrefix?: string): Promise<string[]> {
      const full = listPrefix === undefined ? prefix : `${prefix}${listPrefix}`;
      const keys = await underlying.listKeys(full);
      // Strip the team namespace back off so callers see bare connector keys.
      return keys.map((k) => (k.startsWith(prefix) ? k.slice(prefix.length) : k));
    },
  };
}
