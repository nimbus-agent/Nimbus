import { dbRun, escapeIdentifier } from "../db/write.ts";
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
  return (
    err instanceof Error &&
    new RegExp(String.raw`no such table:\s*${table}\b`, "i").test(err.message)
  );
}

export async function reindexConnector(input: ReindexInput): Promise<ReindexResult> {
  if (input.depth === "metadata_only") {
    // Selection happens INSIDE the same transaction as the UPDATE/DELETEs
    // below (CodeRabbit #1026): reading it outside would let a concurrent
    // write land between the read and the blanket UPDATE, so an item's body
    // could get nulled by that UPDATE while its chunk cleanup below ran
    // against a stale, pre-write item list. `items` is assigned inside the
    // transaction closure and read after — bun:sqlite's `db.transaction()`
    // runs its callback synchronously, so this is not a race.
    let items: Array<{ id: string }> = [];
    input.index.rawDb.transaction(() => {
      // Matches an item that either still has body text to strip OR already
      // has embedding_chunk rows to erase. The second arm is load-bearing:
      // an item whose body/body_preview were already nulled by an OLDER,
      // broken metadata_only run (CodeRabbit #1026) would otherwise never
      // match again, permanently orphaning its embedding_chunk plaintext —
      // exactly the population that already asked for erasure and didn't
      // get it. A re-run of metadata_only must be able to repair them.
      items = input.index.rawDb
        .query(
          `SELECT id FROM item
           WHERE service = ?
             AND (
               (body IS NOT NULL AND body <> '')
               OR (body_preview IS NOT NULL AND body_preview <> '')
               OR EXISTS (SELECT 1 FROM embedding_chunk c WHERE c.item_id = item.id)
             )`,
        )
        .all(input.service) as Array<{ id: string }>;
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

        // PRIMARY erasure mechanism (not the loop below): the `DELETE FROM
        // embedding_chunk` above already fires the dims-aware
        // `AFTER DELETE ON embedding_chunk` triggers —
        // `embedding_chunk_ad_delete_vec384` (index/embedding-v6-sql.ts) and
        // `embedding_chunk_ad_delete_vec1536` (index/vec-items-1536-v30-sql.ts)
        // — which delete the matching vec row via `OLD.vec_rowid` for each
        // chunk row just removed. By the time we reach the loop below, a
        // healthy database has already erased every vector.
        //
        // The loop is deliberate defence-in-depth, not the erasure mechanism:
        // it re-derives each chunk's own vec_rowid/dims (captured above,
        // before the delete) and issues the same delete again in case a
        // future migration alters or drops one of those triggers. In a
        // healthy database every one of its deletes is an expected 0-row
        // no-op. Do not "simplify" it away because it looks like it does
        // nothing — and equally, do not treat it as what makes erasure work.
        for (const chunk of chunks) {
          if (chunk.vec_rowid === null || !SUPPORTED_EMBEDDING_DIMS.has(chunk.dims)) {
            continue;
          }
          // `chunk.dims` is constrained to SUPPORTED_EMBEDDING_DIMS just above,
          // so this can only ever resolve to a real, known vec table name —
          // never caller-influenced interpolation. Still routed through
          // escapeIdentifier() below: I9 applies unconditionally, not only
          // where a particular call site looks unexploitable.
          const vecTable = `vec_items_${chunk.dims}`;
          try {
            dbRun(input.index.rawDb, `DELETE FROM ${escapeIdentifier(vecTable)} WHERE rowid = ?`, [
              chunk.vec_rowid,
            ]);
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
