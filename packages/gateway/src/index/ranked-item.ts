// Type-only module: NO executable runtime logic. It is exact-path-excluded from the coverage floor
// in scripts/coverage-floor/exclusions.ts (a type-only file emits no SF: lcov record). Adding runtime
// logic here would silently bypass the floor — put runtime logic in a separate, covered module.
import type { NimbusItem } from "@nimbus-dev/sdk";

export type RankedIndexItem = NimbusItem & {
  score: number;
  indexPrimaryKey: string;
  indexedType: string;
  canonicalUrl?: string;
  duplicates?: readonly string[];
  semanticSnippet?: string;
  bm25Rank?: number | null;
  vectorRank?: number | null;
  /**
   * The three inputs `compositeSearchScore` folded into `score`, kept so `nimbus explain last`
   * can say WHY an item ranked where it did (spec §2.1).
   *
   * `matchScore` is deliberately NOT named `bm25Score`: on the hybrid path it is the min-max
   * normalised RRF score, and on the FTS path it is a normalised rank POSITION
   * (`1 - i/(n-1)`) — `normalizeBm25LowerIsBetter` is not called on either (spec §2.2).
   * `scoringFormula` is what tells a renderer which scores may be compared with which.
   *
   * All four are optional because candidates from the raw-SQL repo-slug pass have none of
   * them — no score was ever computed for those rows (spec §2.4).
   */
  matchScore?: number;
  recencyComponent?: number;
  servicePriorityComponent?: number;
  scoringFormula?: "hybrid_rrf" | "fts_rank";
};
