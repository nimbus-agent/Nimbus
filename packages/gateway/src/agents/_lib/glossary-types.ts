import type { GapNote } from "./findings.ts";

/** Request params — client-local, like every other agent's input type. */
export type GlossaryInput = {
  term?: string;
  limit?: number;
};

export type GlossarySourceRef = {
  itemId: string;
  title: string;
  url: string | null;
  service: string;
  modifiedAt: number;
};

export type GlossaryEntry = {
  term: string;
  definition: string | null;
  definitionSource: "llm" | "snippet" | null;
  docFreq: number;
  serviceSpread: number;
  firstSeenAt: number;
  lastSeenAt: number;
  topSources: GlossarySourceRef[];
  synonyms: string[];
  nearMisses: string[];
};

export type GlossaryBrief = {
  kind: "glossary";
  /** Literal 1 so a future typo cannot silently compile. Matches the SDK brief shape. */
  agentVersion: 1;
  generatedAt: number;
  latencyMs: number;
  gaps: GapNote[];
  query: { term: string | null; limit: number };
  /** `term` = resolved; `miss` = unknown term with suggestions; `list` = no argument. */
  mode: "list" | "term" | "miss";
  entries: GlossaryEntry[];
  matchedVia: "exact" | "synonym" | null;
  suggestions: string[];
  stats: { total: number; pending: number; vetoed: number; lastPassAt: number | null };
};
