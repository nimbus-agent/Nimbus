/**
 * V62 — the `vec_rowid` join indexes that let a KNN-driven vector search do a point lookup.
 *
 * Both semantic-search queries in this codebase join a sqlite-vec KNN subquery to a rowid-carrying
 * table: `search/vec-store.ts` joins `embedding_chunk ON ec.vec_rowid = knn.rowid`, and
 * `memory/session-memory-store.ts` joins `session_memory ON sm.vec_rowid = knn.rowid`. Neither
 * table had an index on `vec_rowid` — only on `model` / `item_id` and `session_id` / `created_at`.
 *
 * This index alone changes nothing — verified rather than assumed (see the task 1c report):
 * measured at 8,000 items, the pre-fix (`INNER JOIN`) query took 49.3s without this index and
 * 83.4s with it, on the SAME plan, because SQLite still drives the join from the ordinary table —
 * re-executing the brute-force KNN once per outer row — and never reaches an index it has no
 * reason to consult. The `CROSS JOIN` in the two query sites is what actually fixes the defect: it
 * pins the KNN as the outer loop and removes the quadratic term on its own (a 20,000-item
 * synthetic corpus went from 33.3ms/432.4ms at limit 20/500 with no index to a query the old plan
 * would have taken tens of SECONDS to run). What this index removes is the RESIDUAL cost that
 * `CROSS JOIN` alone leaves behind: once the KNN drives, each of its k rows still does a range
 * scan over `idx_embedding_chunk_model` / `idx_session_memory_session` without this index — an
 * O(k·N) cost that widens with both k and corpus size — and this index turns that into an
 * O(log n) point lookup, landing at 16.9ms/22.1ms on the same 20,000-item corpus (2x at limit 20,
 * 19x at limit 500).
 *
 * Both base tables exist on every install: the vec and no-vec variants of the V6 and V10 migrations
 * each create them, so this step needs no branch on whether sqlite-vec loaded.
 */
export const VEC_JOIN_INDEX_V62_SQL = `
CREATE INDEX IF NOT EXISTS idx_embedding_chunk_vec_rowid ON embedding_chunk(vec_rowid);
CREATE INDEX IF NOT EXISTS idx_session_memory_vec_rowid ON session_memory(vec_rowid);
`;
