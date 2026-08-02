import type { ServiceMatchRoute } from "../../decisions/decision-service-scope.ts";
import type { DecisionEvidence, ExtractionSource } from "../../decisions/decision-types.ts";
import type { GapNote } from "./findings.ts";

/** Request params — client-local, like every other agent's input type. */
export interface DecisionsInput {
  /**
   * A DURATION in milliseconds looking back from now (`--since 30d` →
   * `2_592_000_000`), matching every other agent's `sinceMs`. NOT an absolute
   * epoch cutoff — the brief's `query.sinceMs` is the absolute one.
   */
  readonly sinceMs?: number;
  readonly service?: string;
  readonly minConfidence?: number;
  readonly explain?: boolean;
  readonly limit?: number;
}

export interface DecisionsExplainTerm {
  readonly term: string;
  readonly value: number;
  readonly detail: string;
}

/** The render-facing projection of a `DecisionRecord`. */
export interface DecisionsEntry {
  readonly id: string;
  readonly statement: string;
  readonly rationale: string | null;
  readonly alternatives: string[];
  readonly confidence: number;
  readonly decidedAt: number;
  readonly hasAdr: boolean;
  readonly extractionSource: ExtractionSource | null;
  readonly evidence: DecisionEvidence[];
  /** Populated only when `--explain` was requested; otherwise empty. */
  explain: DecisionsExplainTerm[];
  /** Which `--service` route matched, or null when no service filter applied. */
  readonly matchedVia: ServiceMatchRoute | null;
}

export interface DecisionsBrief {
  readonly kind: "decisions";
  readonly agentVersion: number;
  readonly generatedAt: number;
  readonly latencyMs: number;
  readonly gaps: GapNote[];
  query: {
    /**
     * The resolved ABSOLUTE cutoff (`generatedAt - <requested duration>`), not
     * the duration the caller sent. `renderDecisions` subtracts it from
     * `generatedAt` to print the window in days.
     */
    readonly sinceMs: number;
    readonly service: string | null;
    readonly minConfidence: number;
    readonly explain: boolean;
  };
  readonly entries: DecisionsEntry[];
  readonly stats: {
    readonly total: number;
    readonly pending: number;
    readonly extracted: number;
    readonly vetoed: number;
    readonly lastPassAt: number | null;
    /**
     * Of the source item(s) considered within this brief's window, how many
     * were indexed with `body_complete = 0` — a truncated body, whether from
     * a connector that has not declared a full body yet or one that did but
     * exceeded its type's cap. Replaces a blanket "512-character cap" caveat
     * with a precise, per-brief count.
     */
    readonly truncatedSources: number;
  };
}
