import type { CueTier, EvidenceKind } from "./decision-types.ts";

const W_CUE = 0.25;
const W_CORROBORATION = 0.35;
const W_AUTHORITY = 0.2;
const W_COMPLETENESS = 0.2;

export function cueStrength(tier: CueTier): number {
  if (tier === "heading") return 1;
  if (tier === "explicit") return 0.6;
  return 0.25;
}

/** Long-form docs outrank tickets, which outrank chat. */
export function sourceAuthority(serviceType: string): number {
  if (
    serviceType === "notion:page" ||
    serviceType === "confluence:page" ||
    serviceType === "obsidian:obsidian_note"
  ) {
    return 1;
  }
  if (serviceType.endsWith(":issue")) return 0.6;
  return 0.3;
}

/**
 * `source` is excluded deliberately: every decision has one by construction, so
 * counting it would corroborate everything and flatten the term to a constant.
 */
function corroboration(kinds: readonly EvidenceKind[]): number {
  const hasCode = kinds.includes("pr") || kinds.includes("commit");
  const hasArtifact = kinds.includes("migration") || kinds.includes("iac");
  if (hasCode && hasArtifact) return 1;
  if (hasCode) return 0.6;
  if (hasArtifact) return 0.6;
  return 0;
}

function completeness(hasRationale: boolean, hasAlternatives: boolean): number {
  return (hasRationale ? 0.5 : 0) + (hasAlternatives ? 0.5 : 0);
}

export interface PriorityInput {
  readonly tier: CueTier;
  readonly serviceType: string;
}

/**
 * Extraction-queue order. Uses ONLY the two terms knowable without a model,
 * because `confidence` is 0 for every pending row — ordering the queue by it
 * would be arbitrary and would let a burst of weak cues starve heading cues out
 * of the per-pass budget.
 */
export function computePriority(input: PriorityInput): number {
  return W_CUE * cueStrength(input.tier) + W_AUTHORITY * sourceAuthority(input.serviceType);
}

export interface ConfidenceInput extends PriorityInput {
  readonly evidenceKinds: readonly EvidenceKind[];
  readonly hasRationale: boolean;
  readonly hasAlternatives: boolean;
}

export function computeConfidence(input: ConfidenceInput): number {
  const raw =
    W_CUE * cueStrength(input.tier) +
    W_CORROBORATION * corroboration(input.evidenceKinds) +
    W_AUTHORITY * sourceAuthority(input.serviceType) +
    W_COMPLETENESS * completeness(input.hasRationale, input.hasAlternatives);
  return Math.min(1, Math.max(0, raw));
}

export function explainConfidence(
  input: ConfidenceInput,
): Array<{ term: string; value: number; detail: string }> {
  return [
    {
      term: "cue",
      value: W_CUE * cueStrength(input.tier),
      detail: `${input.tier} cue`,
    },
    {
      term: "corroboration",
      value: W_CORROBORATION * corroboration(input.evidenceKinds),
      detail:
        input.evidenceKinds.filter((k) => k !== "source").join(" + ") || "no downstream evidence",
    },
    {
      term: "authority",
      value: W_AUTHORITY * sourceAuthority(input.serviceType),
      detail: input.serviceType,
    },
    {
      term: "completeness",
      value: W_COMPLETENESS * completeness(input.hasRationale, input.hasAlternatives),
      detail: `rationale ${input.hasRationale ? "yes" : "no"}, alternatives ${
        input.hasAlternatives ? "yes" : "no"
      }`,
    },
  ];
}
