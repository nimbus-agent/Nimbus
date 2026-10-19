import { purgeDeletedResidue, withSecureDelete } from "../db/writable-pragmas.ts";
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
const SYNC_STATE_FOR_SERVICE =
  "(connector_id = ? OR connector_id LIKE ? ESCAPE '\\' OR connector_id LIKE ? ESCAPE '\\')";

function syncStateParams(service: string): [string, string, string] {
  const escaped = service.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
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

/**
 * The vectors that go with the service's items: one per `embedding_chunk` row, of any model or
 * dimension (the chunk rows' delete triggers remove the matching vec rows). This used to count
 * `vec_items_384` rows whose rowid equalled an item's rowid, but vec rowids are allocated on their
 * own (`index/vec-rowid.ts`), so that count was unrelated to the service and ignored 1536-dim
 * vectors entirely.
 */
function vecRowsForService(idx: LocalIndex, service: string): number {
  try {
    const row = idx.rawDb
      .query(
        `SELECT COUNT(*) AS c FROM embedding_chunk c
         JOIN item i ON i.id = c.item_id
         WHERE i.service = ?`,
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

  const db = input.index.rawDb;
  withSecureDelete(db, () => {
    db.transaction(() => {
      dbRun(db, `DELETE FROM item WHERE service = ?`, [input.service]);
      dbRun(
        db,
        `DELETE FROM sync_state WHERE ${SYNC_STATE_FOR_SERVICE}`,
        syncStateParams(input.service),
      );
    })();
  });
  purgeDeletedResidue(db);

  for (const key of preflight.vaultKeys) {
    await input.vault.delete(key); // NOSONAR S9382: the macOS vault's delete rewrites one shared key-index file (read-modify-write); concurrent deletes would lose index updates
  }

  return { preflight, deleted: true };
}
