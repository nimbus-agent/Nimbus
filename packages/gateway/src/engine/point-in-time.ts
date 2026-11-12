import type { PointInTimeFacts } from "../index/item-history-at.ts";

/**
 * Point-in-time (`nimbus ask --at`, Phase 10 IC1) helpers shared by the router path, the agent tools and
 * the deterministic disclosure.
 *
 * A turn that carries an instant is a TIME-TRAVEL turn: it may read only the index as it stood then, so it
 * is never offered a live read or a write (plan deviation 14). The agent keeps exactly three tools:
 * `searchLocalIndex` and `fetchMoreIndexResults` (both pass the instant to the index) and `resolvePerson`
 * (the people graph, which has no time axis; names and handles only).
 */
export const POINT_IN_TIME_TOOL_IDS: readonly string[] = [
  "searchLocalIndex",
  "fetchMoreIndexResults",
  "resolvePerson",
];

/**
 * The base tools a point-in-time turn WITHHOLDS, each for a stated reason. A census test requires every
 * base tool to appear in exactly one of the two lists, so a new tool cannot be added without a decision.
 */
export const POINT_IN_TIME_WITHHELD_TOOL_IDS: readonly string[] = [
  "traverseGraph", // current edges
  "listConnectors", // current connector state
  "getAuditLog", // current audit rows
  "findPrsNotTouching", // negation: answers from the current graph (query --at refuses it too)
  "findDeploymentsWithoutIncident",
  "findPeopleWithoutReviews",
  "oncall_now", // a live schedule
  "recallSessionMemory", // session memory is not index state
  "appendSessionMemory", // a write
];

/** The appended sentence that tells the model which instant it is answering for. */
export function pointInTimeInstruction(atMs: number): string {
  return `This question is about the index as it stood at ${new Date(atMs).toISOString()}. Answer only from searchLocalIndex and fetchMoreIndexResults, which already show that time; titles and bodies are as of now, and each item's asOf block holds its state keys at that time. Do not describe later events.`;
}

/**
 * One disclosure's facts from the searches a turn ran. The history start is the LATEST start among them
 * (the weakest coverage, so the "History starts" line is shown whenever any search needed it); the gap
 * count is the largest keyword gap count of any single search (a stated bound: the searches' gap sets
 * overlap in ways this layer cannot see). With no search at all there is nothing to count: zero gaps and
 * the fallback history start.
 */
export function combinePointInTimeFacts(
  atMs: number,
  searched: readonly PointInTimeFacts[],
  fallbackHistoryStartMs: number | null,
): PointInTimeFacts {
  if (searched.length === 0) {
    return { atMs, historyStartMs: fallbackHistoryStartMs, gapCount: 0 };
  }
  let historyStartMs: number | null = null;
  let gapCount = 0;
  for (const f of searched) {
    if (
      f.historyStartMs !== null &&
      (historyStartMs === null || f.historyStartMs > historyStartMs)
    ) {
      historyStartMs = f.historyStartMs;
    }
    gapCount = Math.max(gapCount, f.gapCount);
  }
  return { atMs, historyStartMs, gapCount };
}
