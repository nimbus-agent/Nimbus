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

export function isEmbeddingExcludedType(type: string): boolean {
  return EMBEDDING_EXCLUDED_TYPES.includes(type);
}

/** A SQL fragment for `alias.type`; the types are constants, never caller input. */
export function notEmbeddingExcludedSql(alias: string): string {
  const list = EMBEDDING_EXCLUDED_TYPES.map((t) => `'${t}'`).join(", ");
  return `${alias}.type NOT IN (${list})`;
}
