import type { SourceKind } from "../sources/source-kinds.ts";

export type DecisionStatus = "pending" | "extracted" | "vetoed";

/** The decisions brief's default window (`nimbus decisions`, `decisions.status`): 90 days. */
export const DECISIONS_DEFAULT_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
export type CueTier = "heading" | "explicit" | "weak";
export type EvidenceKind = "source" | "pr" | "commit" | "migration" | "iac" | "adr";
export type ExtractionSource = "llm" | "snippet" | "agent";

export interface DecisionEvidence {
  readonly kind: EvidenceKind;
  readonly entityId: string | null;
  readonly itemId: string | null;
  readonly label: string;
  readonly url: string | null;
  readonly occurredAt: number | null;
}

export interface DecisionRecord {
  readonly id: string;
  readonly sourceItemId: string;
  readonly status: DecisionStatus;
  readonly statement: string | null;
  readonly rationale: string | null;
  readonly alternatives: readonly string[];
  readonly extractionSource: ExtractionSource | null;
  readonly cueTier: CueTier;
  readonly cueText: string;
  readonly priority: number;
  readonly confidence: number;
  readonly decidedAt: number;
  readonly hasAdr: boolean;
  readonly attempts: number;
  readonly lastAttemptAt: number;
  /** `decision_record.scored_kind`: the kind `confidence` was scored under; `null` when unknown. */
  readonly scoredKind: SourceKind | null;
  readonly evidence: readonly DecisionEvidence[];
}
