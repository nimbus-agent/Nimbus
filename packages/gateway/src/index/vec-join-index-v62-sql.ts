/**
 * V62 — the `vec_rowid` join indexes that let a KNN-driven vector search do a point lookup.
 *
 * Both semantic-search queries in this codebase join a sqlite-vec KNN subquery to a rowid-carrying
 * table: `search/vec-store.ts` joins `embedding_chunk ON ec.vec_rowid = knn.rowid`, and
 * `memory/session-memory-store.ts` joins `session_memory ON sm.vec_rowid = knn.rowid`. Neither
 * table had an index on `vec_rowid` — only on `model` / `item_id` and `session_id` / `created_at`.
 *
 * This index is HALF of the fix for the quadratic plan measured in issue #1396; on its own it
 * changes nothing, which was verified rather than assumed (see the task 1c report). SQLite cannot
 * estimate a vec0 KNN subquery's cardinality, assumes it is large, and so drives the join from the
 * ordinary table — re-executing the brute-force KNN once per outer row. Adding this index does not
 * disturb that choice: measured at 8,000 items, the pre-fix query took 49.3s without the index and
 * 83.4s with it, on the same plan. The other half is the `CROSS JOIN` in the two query sites, which
 * pins the KNN as the outer loop; only once the KNN drives does the planner reach for this index,
 * and it is what turns the per-KNN-row probe from a range scan of the whole `model` /`session_id`
 * index into an O(log n) point lookup.
 *
 * Both base tables exist on every install: the vec and no-vec variants of the V6 and V10 migrations
 * each create them, so this step needs no branch on whether sqlite-vec loaded.
 */
export const VEC_JOIN_INDEX_V62_SQL = `
CREATE INDEX IF NOT EXISTS idx_embedding_chunk_vec_rowid ON embedding_chunk(vec_rowid);
CREATE INDEX IF NOT EXISTS idx_session_memory_vec_rowid ON session_memory(vec_rowid);
`;
