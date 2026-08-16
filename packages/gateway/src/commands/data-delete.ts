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

async function buildPreflight(input: RunDataDeleteInput): Promise<DataDeletePreflight> {
  const items = (
    input.index.rawDb
      .query(`SELECT COUNT(*) AS c FROM item WHERE service = ?`)
      .get(input.service) as { c: number }
  ).c;
  const vecRows = vecRowsForService(input.index, input.service);
  const syncTokens = (
    input.index.rawDb
      .query(`SELECT COUNT(*) AS c FROM sync_state WHERE connector_id LIKE ?`)
      .get(`${input.service}%`) as { c: number }
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
    dbRun(input.index.rawDb, `DELETE FROM sync_state WHERE connector_id LIKE ?`, [
      `${input.service}%`,
    ]);
  })();

  for (const key of preflight.vaultKeys) {
    await input.vault.delete(key);
  }

  return { preflight, deleted: true };
}
