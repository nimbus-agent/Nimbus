/** The reserved Vault keyspace for team-scoped secrets. D15: this prefix is named ONLY here. */
export const TEAM_VAULT_PREFIX = "teamvault." as const;

const ENTRY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Derive the OS-Vault key for a team secret. The team keyspace mirrors the connector's own
 * vault keys, so injection can reuse the connector's existing vault-key → env-var mapping
 * (design D8): `teamvault.<entry>.<connectorKey>`.
 */
export function teamVaultKey(entry: string, connectorKey: string): string {
  if (!ENTRY_RE.test(entry)) {
    throw new Error(`team-vault: invalid entry "${entry}" (lowercase alnum + dashes, no dots)`);
  }
  if (connectorKey.length === 0) {
    throw new Error("team-vault: connectorKey must be non-empty");
  }
  return `${TEAM_VAULT_PREFIX}${entry}.${connectorKey}`;
}
