import { dbRun } from "../db/write.ts";
import type { LocalIndex } from "../index/local-index.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";

export type DataDeletePreflight = {
  service: string;
  itemsToDelete: number;
  vecRowsToDelete: number;
  syncTokensToDelete: number;
  vaultEntriesToDelete: number;
  vaultKeys: string[];
  peopleUnlinked: number;
};

export type RunDataDeleteInput = {
  service: string;
  dryRun: boolean;
  vault: NimbusVault;
  index: LocalIndex;
};

export type RunDataDeleteResult = {
  preflight: DataDeletePreflight;
  deleted: boolean;
};

/**
 * A service's own sync_state rows: its exact id plus `<service>-…` / `<service>:…` sub-keys.
 *
 * This was a bare `LIKE '<service>%'`, which also matched every OTHER service whose id merely
 * starts with this one — deleting `github` wiped `github_actions`'s sync state (and `_` is itself
 * a LIKE wildcard). The separator is now required and the service id is escaped.
 */
const SYNC_STATE_FOR_SERVICE = String.raw`(connector_id = ? OR connector_id LIKE ? ESCAPE '\' OR connector_id LIKE ? ESCAPE '\')`;

function syncStateParams(service: string): [string, string, string] {
  const escaped = service
    .replaceAll("\\", String.raw`\\`)
    .replaceAll("%", String.raw`\%`)
    .replaceAll("_", String.raw`\_`);
  return [service, `${escaped}-%`, `${escaped}:%`];
}

async function buildPreflight(input: RunDataDeleteInput): Promise<DataDeletePreflight> {
  const items = (
    input.index.rawDb
      .query(`SELECT COUNT(*) AS c FROM item WHERE service = ?`)
      .get(input.service) as { c: number }
  ).c;
  const vecRows = vecRowsForService(input.index, input.service);
  const syncTokens = (
    input.index.rawDb
      .query(`SELECT COUNT(*) AS c FROM sync_state WHERE ${SYNC_STATE_FOR_SERVICE}`)
      .get(...syncStateParams(input.service)) as { c: number }
  ).c;
  const vaultKeys = await input.vault.listKeys(`${input.service}.`);
  return {
    service: input.service,
    itemsToDelete: items,
    vecRowsToDelete: vecRows,
    syncTokensToDelete: syncTokens,
    vaultEntriesToDelete: vaultKeys.length,
    vaultKeys,
    peopleUnlinked: 0,
  };
}

function vecRowsForService(idx: LocalIndex, service: string): number {
  try {
    const row = idx.rawDb
      .query(
        `SELECT COUNT(*) AS c FROM vec_items_384
         WHERE rowid IN (SELECT rowid FROM item WHERE service = ?)`,
      )
      .get(service) as { c: number } | undefined;
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

export async function runDataDelete(input: RunDataDeleteInput): Promise<RunDataDeleteResult> {
  const preflight = await buildPreflight(input);
  if (input.dryRun) return { preflight, deleted: false };

  input.index.rawDb.transaction(() => {
    dbRun(input.index.rawDb, `DELETE FROM item WHERE service = ?`, [input.service]);
    dbRun(
      input.index.rawDb,
      `DELETE FROM sync_state WHERE ${SYNC_STATE_FOR_SERVICE}`,
      syncStateParams(input.service),
    );
  })();

  for (const key of preflight.vaultKeys) {
    await input.vault.delete(key); // NOSONAR S9382: the macOS vault's delete rewrites one shared key-index file (read-modify-write); concurrent deletes would lose index updates
  }

  return { preflight, deleted: true };
}
