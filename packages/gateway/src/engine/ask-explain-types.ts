// Type-only module: NO executable runtime logic. Coverage-floor excluded like `ranked-item.ts`;
// runtime logic here would silently bypass the floor. Put logic in ask-explain-recorder.ts.

/** Why a candidate did or did not reach the model. Order matters — see spec §4.6. */
export type CandidateOutcome =
  | "shown"
  /** Ranked outside the top K of the primary probe, so it never entered `byId` at all. */
  | "cut: probe slice"
  /** In `byId`, dropped by the final cap. */
  | "cut: over cap"
  /** In `byId` and inside the budget by arrival order, displaced by per-service round-robin. */
  | "cut: service fairness";

export type ContributingPass =
  | { readonly kind: "primary-hybrid" }
  | { readonly kind: "quoted"; readonly query: string }
  | { readonly kind: "repo-slug"; readonly slug: string }
  | { readonly kind: "fallback-term"; readonly term: string };

export type LocalCandidate = {
  readonly sourceId: string;
  readonly service: string;
  readonly indexedType: string;
  readonly title: string;
  /** Absent for repo-slug rows: that projection does not select modified_at (spec §2.4). */
  readonly modifiedAt?: number;
  /** Absent for repo-slug rows: no score was ever computed for them (spec §2.4). */
  readonly score?: number;
  readonly matchScore?: number;
  readonly recencyComponent?: number;
  readonly servicePriorityComponent?: number;
  readonly scoringFormula?: "hybrid_rrf" | "fts_rank";
  readonly pass: ContributingPass;
  readonly outcome: CandidateOutcome;
};

export type CollectedToolCall = {
  readonly toolId: string;
  readonly service: string;
  readonly status: "ok" | "error";
  readonly durationMs: number;
  /** Already `redactAuditPayload`-scrubbed by the collector (spec §4.5). */
  readonly paramsJson: string | null;
  /** Present only for `searchLocalIndex` calls, which rank internally (spec §2.5). */
  readonly ranking?: {
    readonly totalMatches: number;
    readonly itemsInWindow: number;
    readonly sourceSummary: ReadonlyArray<{ service: string; type: string; count: number }>;
  };
};

export type BaseExplainRecord = {
  readonly askedAt: number;
  readonly durationMs: number;
  readonly question: string;
  /**
   * `local` means "some client on this machine's socket". A cli/desktop split is NOT derivable:
   * only the MCP adapter ever calls `session.declareKind`, so a plain `nimbus ask` arrives
   * undeclared. `chatops` is a fact — gateway-main binds that path with `clientId: "chatops"`.
   * Spec §4.3.
   */
  readonly source: "chatops" | "local";
  readonly persona: string;
  /**
   * OPTIONAL, deliberately: the `empty_index` route and a failure at the classification stage
   * never resolve a model at all. Requiring this would force the recorder to fabricate
   * `{ provider: "none", model: "none", isLocal: true }` — inventing a route that did not
   * happen, in a report whose entire purpose is not doing that. Absent means "no model route
   * was resolved", and the renderer says so.
   */
  readonly modelRoute?: {
    readonly provider: string;
    readonly model: string;
    readonly isLocal: boolean;
  };
  readonly classifier:
    | { readonly called: false; readonly reason: string }
    | {
        readonly called: true;
        readonly intent: string;
        readonly confidence: number;
        readonly entities: Readonly<Record<string, string>>;
        readonly destination: string;
      };
  /** Set when the local router threw and the turn silently re-ran on the agent (spec §4.2). */
  readonly fallbackFromLocalRouter?: { readonly error: string };
};

export type AskExplainRecord = BaseExplainRecord &
  (
    | { readonly route: "empty_index" }
    | {
        readonly route: "local_context";
        readonly searchTerms: string;
        readonly fallbackTermFired?: string;
        readonly truncation: {
          readonly shown: number;
          readonly total: number;
          readonly atLeast: boolean;
        };
        readonly pool: readonly LocalCandidate[];
        readonly discardedTail: ReadonlyArray<{ service: string; type: string; count: number }>;
      }
    | {
        readonly route: "agent_tools";
        readonly toolCalls: readonly CollectedToolCall[];
        /**
         * Present only when a local indexed-context probe was ALSO built for this turn — which
         * can only happen on the local-router fallback path: `shouldBuildLocalContext` is false
         * whenever the turn goes straight to the agent, so a non-fallback `agent_tools` turn has
         * no pool here and the field stays absent. `promptWithContext` is built ONCE, above the
         * router-vs-agent fork (`run-conversational-agent.ts`), and the SAME `promptArg` is
         * handed to the agent on fallback — so when present, this pool genuinely reached the
         * model's prompt on this turn, not merely something Nimbus computed and threw away.
         * Absent means none was built, never that one was lost (spec §4.2).
         */
        readonly localContextAlsoGiven?: {
          readonly searchTerms: string;
          readonly fallbackTermFired?: string;
          readonly pool: readonly LocalCandidate[];
          readonly discardedTail: ReadonlyArray<{ service: string; type: string; count: number }>;
        };
      }
    | { readonly route: "plan_dispatch"; readonly plan: string }
    | {
        readonly route: "failed";
        readonly stage: "classification" | "retrieval" | "model";
        readonly error: string;
      }
  );
