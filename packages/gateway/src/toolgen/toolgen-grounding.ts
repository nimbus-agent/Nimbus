import type { LocalIndex } from "../index/local-index.ts";
import type { RankedIndexItem } from "../index/ranked-item.ts";
import { codeUnitCompare } from "../util/code-unit-compare.ts";

export interface GroundedEndpoint {
  readonly serviceName: string;
  readonly method: string;
  readonly path: string;
  readonly operationId: string | null;
  readonly summary: string;
}

export type DraftGrounding =
  | { readonly kind: "endpoints"; readonly count: number; readonly services: readonly string[] }
  | { readonly kind: "description_only" };

/**
 * Titles are written by `openapi-indexer-sync.ts` as `${method} ${path}`.
 * The regex requires the path to begin with `/`, which deliberately excludes AsyncAPI channel
 * names. AsyncAPI channels (e.g. `PUBLISH user/signedup`, `SUBSCRIBE user/signedup`) are pub/sub
 * — MQTT, Kafka, AMQP, WebSocket — and a generated tool reaches the network only through the
 * https-only broker (invariant I39). A generated tool has no transport for pub/sub channels, so
 * grounding the model on such an endpoint could only produce a draft that cannot work. The
 * exclusion prevents this by construction.
 */
const TITLE = /^([A-Z]+) (\/\S*)$/;

const SUMMARY_MAX = 200;

function toEndpoint(item: RankedIndexItem): GroundedEndpoint | null {
  const m = TITLE.exec(item.name);
  if (m === null) return null;
  const meta = (item.rawMeta ?? {}) as Record<string, unknown>;
  const tags = Array.isArray(meta["tags"])
    ? meta["tags"].filter((t): t is string => typeof t === "string")
    : [];
  return {
    serviceName: typeof meta["service_name"] === "string" ? meta["service_name"] : item.service,
    method: m[1] as string,
    path: m[2] as string,
    operationId: typeof meta["operation_id"] === "string" ? meta["operation_id"] : null,
    summary: tags.join(" ").slice(0, SUMMARY_MAX),
  };
}

/**
 * Retrieval for the drafting prompt.
 *
 * Uses the index's `searchRankedAsync` filtered to `api_endpoint`. That is HYBRID search
 * (BM25/FTS5 + vector, fused by RRF) only WHEN semantic search is available — the query must embed,
 * so a machine with no embedder, an empty vector table or a failing embed call falls back to the
 * LEXICAL half alone, silently and by design. Both modes are legitimate retrieval and the § 6.2
 * disclosure does not distinguish them; what a reader must not conclude from this sentence is that
 * a vector lane always ran.
 *
 * Corollary worth stating where the call is: the index READ is local, but the query EMBEDDING
 * follows the `[embedding]` configuration, so on a hybrid/remote-embedder install this function
 * makes a real outbound request carrying `query` — the owner's tool description — ledgered
 * `model`-class by `wrapLedgeredEmbedder` (I29). `draftGeneratedTool` therefore refuses a
 * `drafting = "off"` (or routeless) request BEFORE it calls this.
 *
 * Deliberately NOT a `LIKE '%' || description || '%'` query: that asks whether a natural-language
 * sentence occurs verbatim inside a URL path, which is never true, so grounding would report
 * `description_only` on every request while the disclosure stayed truthful and every test passed.
 * See spec § 6.1.
 *
 * A retrieval failure yields NO grounding rather than failing the draft: grounding widens what the
 * model knows and is never load-bearing for correctness, and the § 6.2 disclosure tells the owner
 * which case they are in.
 */
export function createEndpointFinder(
  index: Pick<LocalIndex, "searchRankedAsync">,
): (query: string, limit: number) => Promise<GroundedEndpoint[]> {
  return async (query, limit) => {
    let items: RankedIndexItem[];
    try {
      items = await index.searchRankedAsync({ itemType: "api_endpoint", name: query, limit });
    } catch {
      return [];
    }
    const out: GroundedEndpoint[] = [];
    for (const item of items) {
      const ep = toEndpoint(item);
      if (ep !== null) out.push(ep);
    }
    return out;
  };
}

export function groundingOf(endpoints: readonly GroundedEndpoint[]): DraftGrounding {
  if (endpoints.length === 0) return { kind: "description_only" };
  return {
    kind: "endpoints",
    count: endpoints.length,
    services: [...new Set(endpoints.map((e) => e.serviceName))].sort(codeUnitCompare),
  };
}
