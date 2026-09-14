import type { CandidateOutcome } from "./ask-explain-types.ts";

/**
 * Decide why a candidate did or did not reach the model, in the order the pipeline applies.
 *
 * `byIdPosition` is a position in INSERTION order, not score order: `capPerService` receives
 * `[...byId.values()]` and `bucketByService` groups "in input order", and the pipeline never
 * sorts globally by score (spec §2.3). So there is no "would have been admitted under a naive
 * top-K by score" — that ordering does not exist anywhere in the code, and phrasing the
 * fairness branch in those terms would be fiction.
 */
export function classifyCandidateOutcome(args: {
  sourceId: string;
  /** Whether the candidate was merged into `byId` by any pass. */
  inById: boolean;
  /** Index within `[...byId.values()]`, or -1 when `inById` is false. */
  byIdPosition: number;
  shownIds: ReadonlySet<string>;
  limit: number;
}): CandidateOutcome {
  if (args.shownIds.has(args.sourceId)) return "shown";
  if (!args.inById) return "cut: probe slice";
  return args.byIdPosition < args.limit ? "cut: service fairness" : "cut: over cap";
}
