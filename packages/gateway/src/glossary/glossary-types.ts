/** Which mining family produced a candidate. Drives the scoring form boost. */
export type CandidateForm = "acronym" | "code" | "identifier" | "hyphenated" | "phrase";

/** A candidate surface form discovered by mining, before any statistics are known. */
export type MinedCandidate = {
  /** Normalized key (see `normalizeTerm`). Never empty. */
  key: string;
  /** The surface form as written, used as `display_term`. */
  surface: string;
  form: CandidateForm;
  /** True only when EVERY observed occurrence began a sentence (family-5 guard). */
  sentenceInitial: boolean;
};

export type GlossaryStatus = "pending" | "consolidated" | "vetoed";

/** `manual` rows are authored in `[glossary.terms]`; see spec §4. */
export type DefinitionSource = "llm" | "snippet" | "manual";

/** One of the (max 5) most-cited items that evidence a term. */
export type GlossarySource = {
  itemId: string;
  title: string;
  url: string | null;
  service: string;
  modifiedAt: number;
};

/** Statistics recomputed from the FTS index — never accumulated. */
export type TermStats = {
  docFreq: number;
  serviceSpread: number;
  firstSeenAt: number;
  lastSeenAt: number;
  topSources: GlossarySource[];
};

/** Per-term progress emitted during phase B, for on-demand passes. */
export type GlossaryPassProgress = {
  done: number;
  total: number;
  consolidated: number;
  upgraded: number;
  vetoed: number;
  retried: number;
};

/** A `glossary_term` row in domain shape. */
export type GlossaryTerm = {
  termKey: string;
  displayTerm: string;
  status: GlossaryStatus;
  definition: string | null;
  definitionSource: DefinitionSource | null;
  docFreq: number;
  serviceSpread: number;
  score: number;
  form: CandidateForm;
  firstSeenAt: number;
  lastSeenAt: number;
  topSources: GlossarySource[];
  synonyms: string[];
  nearMisses: string[];
  consolidatedAt: number | null;
  statsVerifiedAt: number;
  updatedAt: number;
};
