/**
 * What a ranked search actually did — constructed ONCE, in `LocalIndex.searchRankedAsync`, the only
 * site that knows both facts: whether the vector half of hybrid ranking came back, and whether a
 * background embedding pass is still running. Every consumer receives it with the items rather than
 * reconstructing it, for the reason invariant I31 constructs brief disclosures in the renderer: a
 * disclosure a caller has to remember to add is one that eventually goes missing.
 *
 * Before this existed, a query whose embedding timed out or was still warming silently became
 * keyword-only (BM25) while still reporting `scoringFormula: "hybrid_rrf"`, and an empty result read
 * as "searched everything, found nothing".
 */

import type { DualVectorsOutcome } from "../embedding/embedding-readiness.ts";
import type { RankedIndexItem } from "./ranked-item.ts";

/**
 * Why the results were NOT vector-ranked. Every value names something `searchRankedAsync` can
 * observe directly; none is inferred.
 *
 * - `no_query` — a browse with no name; there is nothing to embed.
 * - `semantic_off` — the caller asked for keyword-only.
 * - `no_embedding_runtime` — no embedding runtime is wired: embeddings are disabled by config, or
 *   the runtime failed to start. The index cannot tell those two apart.
 * - `vec_unavailable` — sqlite-vec is not loadable on this connection, or the schema predates it.
 * - `warming` — the model is still loading.
 * - `timeout` — the query embedding did not come back within its budget.
 * - `unavailable` — the runtime answered with no vectors, permanently for this process.
 */
export type RetrievalUnrankedReason =
  | "no_query"
  | "semantic_off"
  | "no_embedding_runtime"
  | "vec_unavailable"
  | "warming"
  | "timeout"
  | "unavailable";

/**
 * Progress of the CURRENT background embedding pass — deliberately not "index coverage". `total` is
 * how many items had no vector for the local model when THIS pass started, and `done` counts items
 * the pass has processed, including any that failed to embed. `nimbus index health` computes real
 * per-connector coverage (items with any vector, over all items) with a full scan; this is the O(1)
 * live counter, and the two numbers differ by construction.
 */
export type BackfillPassProgress = { readonly done: number; readonly total: number };

export type SearchRetrieval = {
  /** True only when a query vector was actually used for ranking. */
  readonly vectorRanked: boolean;
  /** Set exactly when `vectorRanked` is false. */
  readonly reason: RetrievalUnrankedReason | null;
  /** Hybrid runtime only: ranked on ONE dimension because the other half timed out. */
  readonly partial: "local_timeout" | "remote_timeout" | null;
  /** Present only while a background embedding pass is running; results may then be incomplete. */
  readonly backfill: BackfillPassProgress | null;
};

export type SearchRankedResult = {
  readonly items: RankedIndexItem[];
  readonly retrieval: SearchRetrieval;
};

/**
 * Why a search that did not enter the hybrid branch is keyword-only, in the order the branch
 * condition is evaluated. `vec_unavailable` is what remains when a name, semantic mode and a runtime
 * were all present: sqlite-vec is not loadable on this connection or the schema predates it.
 */
export function unrankedReasonFor(input: {
  readonly nameQ: string;
  readonly semanticOn: boolean;
  readonly hasRuntime: boolean;
}): "no_query" | "semantic_off" | "no_embedding_runtime" | "vec_unavailable" {
  if (!input.semanticOn) return "semantic_off";
  if (input.nameQ === "") return "no_query";
  if (!input.hasRuntime) return "no_embedding_runtime";
  return "vec_unavailable";
}

/** The retrieval block for a search that never reached the embedding runtime. */
export function unrankedRetrieval(
  reason: Exclude<RetrievalUnrankedReason, "warming" | "timeout" | "unavailable">,
  backfill: BackfillPassProgress | null,
): SearchRetrieval {
  return { vectorRanked: false, reason, partial: null, backfill };
}

/** The retrieval block for a search that asked the runtime for a query vector. */
export function retrievalFromOutcome(
  outcome: DualVectorsOutcome,
  backfill: BackfillPassProgress | null,
): SearchRetrieval {
  const { vectors, degraded } = outcome;
  const vectorRanked = vectors.vec384 !== null || vectors.vec1536 !== null;
  let reason: RetrievalUnrankedReason | null = null;
  if (!vectorRanked) {
    reason = degraded ?? "unavailable";
  }
  return {
    vectorRanked,
    reason,
    partial: vectorRanked ? (vectors.partial ?? null) : null,
    backfill,
  };
}

const UNRANKED_NOTES: Readonly<Record<RetrievalUnrankedReason, string | null>> = {
  // The caller asked for no semantic ranking, or there was nothing to embed — not a degradation.
  no_query: null,
  semantic_off: null,
  no_embedding_runtime:
    "semantic ranking unavailable (embeddings are disabled or did not start) — keyword-only results",
  vec_unavailable:
    "semantic ranking unavailable (the vector index could not be loaded) — keyword-only results",
  warming:
    "semantic ranking unavailable (the embedding model is still loading) — keyword-only results",
  timeout: "semantic ranking unavailable (the query embedding timed out) — keyword-only results",
  unavailable:
    "semantic ranking unavailable (the embedding runtime failed for this session) — keyword-only results",
};

/**
 * Plain-language notes for a retrieval block, empty when there is nothing to disclose. The CLI keeps
 * its own copy of this wording (it reaches the gateway over IPC only and never imports gateway
 * source); the two are pinned against each other by `search-retrieval-wording.test.ts` in the CLI.
 */
export function describeRetrieval(r: SearchRetrieval): string[] {
  const notes: string[] = [];
  if (!r.vectorRanked && r.reason !== null) {
    const note = UNRANKED_NOTES[r.reason];
    if (note !== null) notes.push(note);
  }
  if (r.partial === "remote_timeout") {
    notes.push("semantic ranking used local vectors only (the remote embedding timed out)");
  } else if (r.partial === "local_timeout") {
    notes.push("semantic ranking used remote vectors only (the local embedding timed out)");
  }
  if (r.backfill !== null) {
    notes.push(
      `background embedding in progress: ${r.backfill.done.toLocaleString("en-US")} of ` +
        `${r.backfill.total.toLocaleString("en-US")} items processed this pass — results may be ` +
        "incomplete; run 'nimbus index health' for per-connector coverage",
    );
  }
  return notes;
}

/** The notes as one tool-result field for the model, omitted entirely when there are none. */
export function retrievalNoteFor(r: SearchRetrieval): { retrievalNote?: string } {
  const notes = describeRetrieval(r);
  return notes.length === 0 ? {} : { retrievalNote: notes.join("; ") };
}
