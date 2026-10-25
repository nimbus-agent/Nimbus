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

/**
 * `manual` rows are authored in `[glossary.terms]`; see spec §4. `agent` rows are owner-accepted
 * MCP capture proposals, written only by `upsertAgentTerm`.
 */
export type DefinitionSource = "llm" | "snippet" | "manual" | "agent";

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
  /** Distinct `service:type` over the same match, sorted. */
  contributingTypes: readonly string[];
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
  /**
   * True when the stored definition was written while a source type that is not remote-eligible
   * contributed (V75, spec § 7.1). It pins the search copy local until the definition is rewritten;
   * a statistics refresh never clears it.
   */
  definitionLocal: boolean;
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

/**
 * The source-type sets one read of the glossary resolves against (role packs P2, spec § 7).
 *
 * `effective` is what the current mapping mines; `known` is every type the pass has ever tracked
 * (`knownSourceTypes`), which stored statistics are computed over so a mapping change never
 * rewrites a row. `fast` is true when every known type is effective: nothing can be hidden, so the
 * queues and counts skip the per-term existence check entirely.
 */
export type GlossarySets = {
  readonly effective: readonly string[];
  readonly known: readonly string[];
  readonly fast: boolean;
};
