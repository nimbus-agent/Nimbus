/**
 * Item types that are NEVER embedded (Phase 10 FinOps, D-FO-10). A `cost_allocation` row is a number
 * with a label: it has nothing for a vector to find, and a daily row per series would add tens of
 * thousands of chunks. The exclusion lives in every place that SELECTs or schedules rows to embed,
 * NOT in `SqliteEmbeddingPipeline.embedItem`: an `embedItem` that merely skips writes no chunk, and
 * `backfillAll`'s drain loop re-selects "items with no chunk" forever.
 *
 * Add a type here and every site below follows. The sites (keep this list true):
 *   - index/item-store.ts            `upsertIndexedItemForSync` (no schedule call)
 *   - embedding/lazy-scheduler.ts, embedding/create-routing-runtime.ts, embedding/embedding-worker-core.ts
 *                                    (the three `scheduleItemEmbedding` / `embed_item` row re-readers)
 *   - embedding/pipeline.ts          `backfillAll` and `backfillForRoutingKeys` (COUNT and SELECT each)
 *   - ipc/index-reembed-rpc.ts       `buildCandidateSql`
 *   - db/index-health.ts             `readPerService` (so cost rows never read as un-embedded)
 *
 * A `cost_recommendation` is NOT excluded: it is short prose, embedded on the LOCAL model only, and
 * it stays out of `PROSE_HEAVY_TYPES` (embedding/routing.ts) so it never reaches a remote embedder.
 */
export const EMBEDDING_EXCLUDED_TYPES: readonly string[] = ["cost_allocation"];

/**
 * Types that may be embedded ONLY by a local embedder. A pipeline built on a remote embedder (for
 * example `[embedding] provider = "openai"`, or a re-embed with an `openai:` model) must skip them:
 * `PROSE_HEAVY_TYPES` only governs the hybrid router, not a single-embedder pipeline.
 */
export const LOCAL_ONLY_EMBEDDING_TYPES: readonly string[] = ["cost_recommendation"];

/** `remote` is true when the embedder that would receive the row is not local (invariant I34). */
export function isEmbeddingExcludedType(type: string, remote = false): boolean {
  return (
    EMBEDDING_EXCLUDED_TYPES.includes(type) || (remote && LOCAL_ONLY_EMBEDDING_TYPES.includes(type))
  );
}

/** A SQL fragment for `alias.type`; the types are constants, never caller input. */
export function notEmbeddingExcludedSql(alias: string, remote = false): string {
  const types = remote
    ? [...EMBEDDING_EXCLUDED_TYPES, ...LOCAL_ONLY_EMBEDDING_TYPES]
    : EMBEDDING_EXCLUDED_TYPES;
  return `${alias}.type NOT IN (${types.map((t) => `'${t}'`).join(", ")})`;
}
