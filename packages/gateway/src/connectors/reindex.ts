import { dbRun } from "../db/write.ts";
import { SUPPORTED_EMBEDDING_DIMS } from "../embedding/routing.ts";
import type { LocalIndex } from "../index/local-index.ts";

export type ReindexDepth = "metadata_only" | "summary" | "full";

export type ReindexInput = {
  index: LocalIndex;
  service: string;
  depth: ReindexDepth;
};

export type ReindexResult = {
  itemsAffected: number;
  depth: ReindexDepth;
  mode: "deepen" | "shallow" | "same";
};

/**
 * `vec_items_<dims>` are sqlite-vec virtual tables that may be entirely
 * absent when the extension failed to load on this install (see
 * `index/sqlite-vec-load.ts` / the `*_NO_VEC_*` migration variants) — in that
 * case there is nothing to erase there and the delete is a legitimate no-op.
 * Any OTHER failure (corrupt DB, disk full, etc.) must not be swallowed: a
 * masked real error would let the caller believe erasure succeeded when it
 * did not.
 */
function isMissingVecTableError(err: unknown, table: string): boolean {
  return err instanceof Error && new RegExp(`no such table:\\s*${table}\\b`, "i").test(err.message);
}

export async function reindexConnector(input: ReindexInput): Promise<ReindexResult> {
  if (input.depth === "metadata_only") {
    const items = input.index.rawDb
      .query(
        `SELECT id FROM item
         WHERE service = ?
           AND ((body IS NOT NULL AND body <> '')
                OR (body_preview IS NOT NULL AND body_preview <> ''))`,
      )
      .all(input.service) as Array<{ id: string }>;
    input.index.rawDb.transaction(() => {
      dbRun(
        input.index.rawDb,
        `UPDATE item SET body = NULL, body_preview = NULL, body_complete = 0 WHERE service = ?`,
        [input.service],
      );
      for (const item of items) {
        // Read each chunk's OWN vec_rowid + dims before the chunk row is gone.
        // vec_rowid is a table-wide monotonic counter (embedding/pipeline.ts)
        // unrelated to item.rowid — the item's own rowid must never be used
        // to key a vec table delete (that was bug #2: it either misses the
        // redacted item's real vectors or corrupts an unrelated item's).
        const chunks = input.index.rawDb
          .query(`SELECT vec_rowid, dims FROM embedding_chunk WHERE item_id = ?`)
          .all(item.id) as Array<{ vec_rowid: number | null; dims: number }>;

        dbRun(input.index.rawDb, `DELETE FROM embedding_chunk WHERE item_id = ?`, [item.id]);

        for (const chunk of chunks) {
          if (chunk.vec_rowid === null || !SUPPORTED_EMBEDDING_DIMS.has(chunk.dims)) {
            continue;
          }
          // `chunk.dims` is constrained to SUPPORTED_EMBEDDING_DIMS just above,
          // so this can only ever resolve to a real, known vec table name —
          // never caller-influenced interpolation.
          const vecTable = `vec_items_${chunk.dims}`;
          try {
            dbRun(input.index.rawDb, `DELETE FROM ${vecTable} WHERE rowid = ?`, [chunk.vec_rowid]);
          } catch (err) {
            if (!isMissingVecTableError(err, vecTable)) {
              throw err;
            }
          }
        }
      }
    })();
    if (items.length > 0) {
      input.index.recordAudit({
        actionType: "data.minimization.prune",
        hitlStatus: "approved",
        actionJson: JSON.stringify({
          connector: input.service,
          items_affected: items.length,
          depth: input.depth,
        }),
        timestamp: Date.now(),
      });
    }
    return { itemsAffected: items.length, depth: input.depth, mode: "shallow" };
  }
  return { itemsAffected: 0, depth: input.depth, mode: "deepen" };
}
