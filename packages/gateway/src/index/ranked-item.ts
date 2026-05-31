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
};
