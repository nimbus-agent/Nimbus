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

export async function reindexConnector(input: ReindexInput): Promise<ReindexResult> {
  if (input.depth === "metadata_only") {
    const rowids = input.index.rawDb
      .query(
        `SELECT rowid FROM item WHERE service = ? AND (body_preview IS NOT NULL AND body_preview <> '')`,
      )
      .all(input.service) as Array<{ rowid: number }>;
    input.index.rawDb.transaction(() => {
      input.index.rawDb.run(`UPDATE item SET body_preview = NULL WHERE service = ?`, [
        input.service,
      ]);
      for (const r of rowids) {
        try {
          input.index.rawDb.run(`DELETE FROM vec_items_384 WHERE rowid = ?`, [r.rowid]);
        } catch {
          /* vec table absent */
        }
      }
    })();
    if (rowids.length > 0) {
      input.index.recordAudit({
        actionType: "data.minimization.prune",
        hitlStatus: "approved",
        actionJson: JSON.stringify({
          connector: input.service,
          items_affected: rowids.length,
          depth: input.depth,
        }),
        timestamp: Date.now(),
      });
    }
    return { itemsAffected: rowids.length, depth: input.depth, mode: "shallow" };
  }
  return { itemsAffected: 0, depth: input.depth, mode: "deepen" };
}
