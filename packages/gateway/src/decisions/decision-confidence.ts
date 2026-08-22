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
/**
 * Corroboration from evidence the pass ACTUALLY emits.
 *
 * This used to reserve its full 1.0 for `migration`/`iac` evidence and award 0.6 for PR/commit,
 * which capped total confidence at 0.86 — a scale on which no decision could ever score full
 * marks. Nothing writes those two kinds: the union, this read and the V47 `CHECK` are the only
 * three sites either literal appears in, so both branches were dead and the ceiling was an
 * artefact of scoring against evidence that does not exist.
 *
 * Dropping them makes the score mean what the brief's own remediation line already told readers
 * to read it as — "a maximally-corroborated decision". The kinds stay in `EvidenceKind` and in
 * the V47 constraint: if the pass is later wired to `pr_changed_file`, re-adding a term here is
 * a smaller change than re-adding a column.
 */
function corroboration(kinds: readonly EvidenceKind[]): number {
  // `source` is still excluded — every decision has one by construction.
  return kinds.includes("pr") || kinds.includes("commit") ? 1 : 0;
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

/**
 * The evidence kinds any writer in `decision-corroborate.ts` actually emits.
 *
 * `EvidenceKind` also declares `migration` and `iac`. Nothing writes them — the union, the
 * scoring read in `corroboration()` and the V47 `CHECK` are the only three sites either literal
 * appears in. That gap is why `computeConfidence` cannot reach 1.0, and stating the emitted set
 * HERE, next to the scorer, is what lets the ceiling be derived instead of written into a
 * sentence as `0.86` and left to drift.
 */
export const EMITTED_EVIDENCE_KINDS: readonly EvidenceKind[] = ["source", "pr", "commit", "adr"];

/**
 * The highest confidence the pass can actually produce, given what is emitted.
 *
 * Reads 1.0 today, and that is the point: before F25 it was 0.86, because `corroboration()`
 * reserved its top score for `migration`/`iac` evidence nothing writes. A 0..1 score on which no
 * real decision could reach full marks needed a standing apology in every brief.
 *
 * Kept as a SCALE GUARD rather than removed with the note it used to feed. It is the canonical
 * statement of "what is reachable", it lives beside the weights it derives from, and
 * `confidence-ceiling.test.ts` fails if a weight or an emitted kind changes the answer — so the
 * scale cannot drift the way the prose figure did. Everything except corroboration is set to its
 * best case, because each of those IS reachable: a heading cue in a Notion page with both
 * rationale and alternatives.
 */
export function maxReachableConfidence(): number {
  return computeConfidence({
    tier: "heading",
    evidenceKinds: EMITTED_EVIDENCE_KINDS,
    serviceType: "notion:page",
    hasRationale: true,
    hasAlternatives: true,
  });
}
