import type { LocalIndex } from "../index/local-index.ts";
import type { IndexSearch } from "./brief-registry.ts";

/**
 * The real `IndexSearch` the gateway hands `buildRegistry`.
 *
 * Extracted out of `platform/assemble.ts` so the ONE place this feature's behaviour lives is
 * reachable from a test. Every brief test injects a stub search, so while this closure sat
 * inside the boot function nothing proved the query it actually issues — restoring an
 * `itemType: "web_clip"` filter would have reverted the whole widening with a green suite.
 * See brief-index-search.test.ts, which seeds a real LocalIndex with a clip and a non-clip.
 */
export function createBriefIndexSearch(localIndex: LocalIndex): IndexSearch {
  return async (query, limit) => {
    // NO itemType filter: a brief draws on the whole index. `IndexSearchQuery.itemType`
    // is optional and the SQL applies it only when set, so omitting it is the widening.
    const hits = await localIndex.searchRankedAsync(
      { name: query, limit },
      { semantic: true, contextChunks: 2 },
    );
    return {
      // NOTE: RankedIndexItem extends the SDK's NimbusItem, whose title field is `name`
      // — there is no `title` and no `body_preview` on it (see index/ranked-item.ts and
      // @nimbus-dev/sdk types.d.ts). The only body text available here is the matched
      // chunk in `semanticSnippet`, which is absent on the BM25 fallback path.
      hits: hits.map((h) => ({
        itemId: h.indexPrimaryKey,
        itemType: h.itemType,
        title: h.name,
        url: h.url ?? h.canonicalUrl ?? null,
        snippet: h.semanticSnippet ?? h.name,
      })),
      // A hit with no vectorRank anywhere means the hybrid path did not run.
      semanticAvailable: hits.some((h) => h.vectorRank !== undefined && h.vectorRank !== null),
    };
  };
}
