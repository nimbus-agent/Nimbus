import {
  describeEmbeddingWarming,
  EMBEDDING_WARMING_CODE,
  EMBEDDING_WARMING_RPC_CODE,
} from "../../embedding/embedding-readiness.ts";
import { pointInTimeDisclosure } from "../../index/item-history-at.ts";
import type { IndexSearchQuery, LocalIndex } from "../../index/local-index.ts";
import { describeRetrieval } from "../../index/search-retrieval.ts";
import { type AtTimeError, parseAtParam } from "../../util/point-in-time-parse.ts";
import { gatewayZone } from "../../util/zoned-time.ts";
import type { ServerCtx } from "./context.ts";
import { RpcMethodError } from "./rpc-error.ts";

type SearchRankedResult = Awaited<ReturnType<LocalIndex["searchRankedAsync"]>>;

function parseSearchAt(raw: unknown): number | undefined {
  try {
    return parseAtParam(raw, Date.now(), gatewayZone());
  } catch (e) {
    throw new RpcMethodError(-32602, `index.searchRanked: ${(e as AtTimeError).message}`);
  }
}

function clampedInt(raw: unknown, min: number, max: number, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw)
    ? Math.min(max, Math.max(min, Math.floor(raw)))
    : fallback;
}

/**
 * #928 false-green guard. The gateway now binds BEFORE the embedding model is loaded, so a
 * semantic query can arrive with no vectors yet. Serving it anyway silently degrades to BM25
 * — and a query with no lexical overlap then returns `[]`, which reads exactly like "searched
 * everything, found nothing". Say "not yet" instead, and hand back the readiness so the client
 * can show progress or retry. Only WARMING is transient: `disabled`/`unavailable` are
 * permanent for this process, so those serve keyword results as before.
 */
export function assertSemanticSearchReady(ctx: ServerCtx, semantic: boolean): void {
  const readiness = ctx.options.embeddingReadiness?.();
  if (semantic && readiness?.state === "warming") {
    throw new RpcMethodError(
      EMBEDDING_WARMING_RPC_CODE,
      `index.searchRanked: ${describeEmbeddingWarming(readiness)}`,
      { code: EMBEDDING_WARMING_CODE, readiness },
    );
  }
}

/**
 * `at` (Phase 10 IC1): a PRESENT but unusable value is refused, and an undisclosed historical
 * answer is the failure this feature exists to prevent, so `at` requires the envelope that
 * carries the disclosure.
 */
function applyPointInTime(rec: Record<string, unknown>, query: IndexSearchQuery): void {
  const atMs = parseSearchAt(rec["at"]);
  if (atMs === undefined) {
    return;
  }
  if (rec["envelope"] !== true) {
    throw new RpcMethodError(-32602, "index.searchRanked: at requires envelope: true");
  }
  query.atMs = atMs;
}

export function buildSearchRankedQuery(rec: Record<string, unknown>): IndexSearchQuery {
  const query: IndexSearchQuery = { limit: clampedInt(rec["limit"], 1, 500, 20) };
  applyPointInTime(rec, query);
  if (typeof rec["name"] === "string" && rec["name"] !== "") {
    query.name = rec["name"];
  }
  if (typeof rec["service"] === "string") {
    query.service = rec["service"];
  }
  if (typeof rec["itemType"] === "string") {
    query.itemType = rec["itemType"];
  }
  return query;
}

export function searchRankedOptions(rec: Record<string, unknown>): {
  semantic: boolean;
  contextChunks: number;
} {
  return {
    semantic: rec["semantic"] !== false,
    contextChunks: clampedInt(rec["contextChunks"], 0, 8, 2),
  };
}

/**
 * OPT-IN, and only on the wire. The published `@nimbus-dev/client` (0.17.3) asserts this method
 * returns an array, so an unconditional envelope would make every existing client throw. First-party
 * callers pass `envelope: true` and get the disclosure plus the gateway's own wording for it, so no
 * client keeps a second copy of the notes. A caller that does not ask still receives undisclosed
 * partial results — the stated residual (docs/architecture.md, search retrieval disclosure).
 */
export function shapeSearchRankedResult(result: SearchRankedResult, envelope: boolean): unknown {
  if (!envelope) {
    return result.items;
  }
  const notes = describeRetrieval(result.retrieval);
  if (result.pointInTime === undefined) {
    return { items: result.items, retrieval: result.retrieval, notes };
  }
  const zone = gatewayZone();
  const disclosure = pointInTimeDisclosure({ ...result.pointInTime, zone });
  return {
    items: result.items,
    retrieval: result.retrieval,
    notes: [...notes, ...disclosure],
    asOf: {
      atMs: result.pointInTime.atMs,
      zone,
      historyStartMs: result.pointInTime.historyStartMs,
      gapCount: result.pointInTime.gapCount,
    },
  };
}
