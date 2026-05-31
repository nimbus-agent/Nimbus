import type { Database } from "bun:sqlite";
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
  const vecTable = `vec_items_${String(dims)}`;
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
