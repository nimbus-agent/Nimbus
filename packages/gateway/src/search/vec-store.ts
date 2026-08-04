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

export function vectorSearchChunks(
  db: Database,
  options: {
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
  },
): VectorChunkHit[] {
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
  let sql = `
    SELECT ec.item_id AS itemId, ec.chunk_index AS chunkIndex, ec.chunk_text AS chunkText,
           ec.vec_rowid AS vecRowid, knn.distance AS distance
    FROM (
      SELECT rowid, distance FROM ${vecTable} WHERE embedding MATCH ? AND k = ?
    ) knn
    INNER JOIN embedding_chunk ec ON ec.vec_rowid = knn.rowid AND ec.model = ?
    INNER JOIN item i ON i.id = ec.item_id
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
  sql += ` ORDER BY knn.distance`;
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
