import type { Database } from "bun:sqlite";
import { escapeIdentifier } from "../db/write.ts";
import { SUPPORTED_EMBEDDING_DIMS } from "../embedding/routing.ts";

export type VectorChunkHit = {
  itemId: string;
  chunkIndex: number;
  chunkText: string;
  vecRowid: number;
  distance: number;
};

export type VectorSearchChunkOptions = {
  queryEmbedding: Float32Array;
  model: string;
  limit: number;
  service?: string;
  itemType?: string;
  since?: number;
  /**
   * Slice 6c: restrict hits to items whose `metadata.channel` is in this allowlist
   * (`json_extract(i.metadata,'$.channel') IN (...)`). Empty/undefined → no channel filter.
   * The KNN already bounds candidates to the top-`limit`; this filters within that set.
   */
  metadataChannelIn?: readonly string[];
};

/**
 * The SQL + bound parameters `vectorSearchChunks` executes.
 *
 * Exported so the query-plan regression test can `EXPLAIN QUERY PLAN` the query PRODUCTION runs,
 * rather than a transcription of it that could stay green while this file regressed. It is a pure
 * builder: it touches no database and holds no state.
 */
export function buildVectorChunkQuery(options: VectorSearchChunkOptions): {
  sql: string;
  params: Array<string | number | Float32Array>;
} {
  const dims = options.queryEmbedding.length;
  if (!SUPPORTED_EMBEDDING_DIMS.has(dims)) {
    throw new Error(
      `unsupported query embedding dim: ${String(dims)} (expected one of ${Array.from(
        SUPPORTED_EMBEDDING_DIMS,
      ).join(",")})`,
    );
  }
  // `dims` is constrained to SUPPORTED_EMBEDDING_DIMS just above, so this can
  // only ever resolve to a real, known vec table name — never
  // caller-influenced interpolation. Still routed through escapeIdentifier()
  // below: I9 applies unconditionally, not only where a particular call site
  // looks unexploitable (same rationale as connectors/reindex.ts).
  const vecTable = escapeIdentifier(`vec_items_${String(dims)}`);
  const lim = Math.min(500, Math.max(1, Math.floor(options.limit)));
  const q = new Float32Array(options.queryEmbedding);
  // CROSS JOIN, not INNER JOIN, and the difference is four orders of magnitude — see the
  // "join order is pinned" cases in vec-store-join-order.test.ts, which fail if either keyword
  // is relaxed, alongside the equivalence cases proving the row set and its order are unchanged.
  //
  // The two are semantically identical in SQLite; CROSS only removes the planner's freedom to
  // reorder, forcing the left relation (`knn`) to be the OUTER loop. Left to itself the planner
  // cannot estimate a vec0 KNN subquery's cardinality, assumes it is large, and so drives the join
  // from `embedding_chunk` filtered on `model` — which on an install with one local embedder
  // matches every row — re-executing the brute-force KNN scan once per chunk. Measured on this
  // query at 8,000 items, on the pre-V62 schema (no `vec_rowid` index at all — the full "before"
  // this fix starts from): 49.3s before, 8.5ms after (issue #1396; task 1c report).
  //
  // CROSS JOIN alone removes the quadratic term outright: on a 20,000-item synthetic corpus,
  // pinning the KNN as the outer loop with no V62 index at all took 33.3ms at limit 20 and
  // 432.4ms at limit 500 — tens of seconds down to tens of milliseconds. What the V62
  // `idx_embedding_chunk_vec_rowid` index removes is the RESIDUAL cost that outer loop leaves
  // behind: without it, each of the KNN's k rows still does a range scan over
  // `idx_embedding_chunk_model`, an O(k·N) cost that widens with both k and corpus size; with
  // it, that scan becomes an O(log n) point lookup, landing at 16.9ms / 22.1ms on the same
  // corpus — a 2x gap at limit 20 that widens to 19x at limit 500. The index CANNOT do this on
  // its own: verified separately, at 8,000 items the pre-fix (INNER JOIN) plan took 49.3s
  // without the index and 83.4s with it, on an identical plan — a query the planner still drives
  // from `embedding_chunk` never reaches this index at all. So the two halves are not
  // symmetric: `CROSS JOIN` is what fixes the defect, and the index is what keeps the fixed
  // query fast as `limit` and corpus size grow.
  let sql = `
    SELECT ec.item_id AS itemId, ec.chunk_index AS chunkIndex, ec.chunk_text AS chunkText,
           ec.vec_rowid AS vecRowid, knn.distance AS distance
    FROM (
      SELECT rowid, distance FROM ${vecTable} WHERE embedding MATCH ? AND k = ?
    ) knn
    CROSS JOIN embedding_chunk ec ON ec.vec_rowid = knn.rowid AND ec.model = ?
    CROSS JOIN item i ON i.id = ec.item_id
    WHERE 1 = 1
  `;
  const params: Array<string | number | Float32Array> = [q, lim, options.model];
  if (options.service !== undefined && options.service !== "") {
    sql += ` AND i.service = ?`;
    params.push(options.service);
  }
  if (options.itemType !== undefined && options.itemType !== "") {
    sql += ` AND i.type = ?`;
    params.push(options.itemType);
  }
  if (options.since !== undefined && options.since > 0) {
    sql += ` AND i.modified_at >= ?`;
    params.push(options.since);
  }
  if (options.metadataChannelIn !== undefined && options.metadataChannelIn.length > 0) {
    const placeholders = options.metadataChannelIn.map(() => "?").join(", ");
    sql += ` AND json_extract(i.metadata, '$.channel') IN (${placeholders})`;
    for (const ch of options.metadataChannelIn) params.push(ch);
  }
  // The `, ec.vec_rowid ASC` tiebreak is NOT decoration and NOT a behaviour change — it is what
  // keeps "results identical" literally true. `ORDER BY knn.distance` alone leaves rows with an
  // EXACTLY equal distance in whatever order the join emitted them, and the join order is the
  // thing this fix changed: measured on a fixture whose chunks share embeddings in groups of
  // three, the pre-fix query returned vec_rowids 1,2,3,4,5,6,… and the CROSS-JOIN query returned
  // 3,2,1,6,5,4,… — same set, every tie group reversed. Exact ties are not exotic: duplicate
  // chunk text produces byte-identical embeddings and therefore identical distances.
  //
  // That reordering is user-visible through three order-dependent consumers, none of which
  // re-sorts by anything else: `hybrid-internal.ts`'s `bestVectorRanksByItem` derives a rank from
  // the ARRAY INDEX and feeds it to the RRF score, its `firstChunkByItem` keeps the FIRST chunk
  // per item (so the snippet shown to the user changes), and `dual-search.ts` stable-sorts then
  // slices to `limit` (so a tie group straddling the boundary changes WHICH row is returned).
  //
  // Ascending `vec_rowid` is the pre-fix order, not a newly invented one: the old plan walked
  // `idx_embedding_chunk_model`, i.e. ascending `embedding_chunk` rowid, and the pipeline writes
  // each vec row and its chunk row together with monotonically increasing ids, so the two agree
  // on every database this code creates. Verified against the pre-fix query rather than assumed
  // — see the tie-bearing equivalence case in vec-store-join-order.test.ts.
  sql += ` ORDER BY knn.distance, ec.vec_rowid ASC`;
  return { sql, params };
}

export function vectorSearchChunks(
  db: Database,
  options: VectorSearchChunkOptions,
): VectorChunkHit[] {
  const { sql, params } = buildVectorChunkQuery(options);
  const rows = db.query(sql).all(...params) as Array<{
    itemId: string;
    chunkIndex: number;
    chunkText: string;
    vecRowid: number;
    distance: number;
  }>;
  return rows.map((r) => ({
    itemId: r.itemId,
    chunkIndex: r.chunkIndex,
    chunkText: r.chunkText,
    vecRowid: r.vecRowid,
    distance: r.distance,
  }));
}
