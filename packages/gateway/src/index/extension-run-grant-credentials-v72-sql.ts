/**
 * V72 — the credentials an approved extension runs with (connector unbundling, gateway PR 2). One
 * canonical, key-sorted JSON object per grant: credential name -> `{ env, vaultKey }`, the Vault key
 * resolved at approval (a continuity binding's legacy key, else `ext.<serviceId>.<name>`). Names and
 * Vault keys only — never a value. A grant approved before V72 reads `'{}'`, which is exactly what an
 * extension declaring no credentials serializes to, so no existing grant goes stale. Only this file,
 * the V70 DDL and `extensions/run-grant-store.ts` name the table (static rule D33(b)).
 */
export const EXTENSION_RUN_GRANT_CREDENTIALS_V72_SQL = [
  `ALTER TABLE extension_run_grant ADD COLUMN credentials_json TEXT NOT NULL DEFAULT '{}'`,
] as const;
