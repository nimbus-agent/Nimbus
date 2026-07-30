import type { CandidateForm } from "./glossary-types.ts";

/**
 * Ranking for the consolidation queue.
 *
 * Spread across services is weighted deliberately: a term appearing in both
 * Slack AND Jira is far more likely to be real team vocabulary than one
 * appearing forty times in a single noisy channel.
 */
export const FORM_BOOST: Record<CandidateForm, number> = {
  acronym: 1.3,
  code: 1.2,
  identifier: 1.1,
  hyphenated: 1.05,
  phrase: 1.0,
};

/**
 * Spread grows GEOMETRICALLY, not linearly.
 *
 * A linear bonus does not actually deliver the intent above: with
 * `1 + 0.5*(spread-1)`, a term seen 40 times in one noisy channel scores 3.714
 * and beats a genuine two-service term at 3.597 — the precise case the
 * weighting exists to defeat. At base 1.6 the two-service term scores 3.836
 * and wins, while frequency still separates terms at equal spread.
 */
const SPREAD_BASE = 1.6;

export function scoreTerm(input: {
  docFreq: number;
  serviceSpread: number;
  form: CandidateForm;
}): number {
  if (input.docFreq <= 0) return 0;
  const spread = Math.max(1, input.serviceSpread);
  return Math.log1p(input.docFreq) * SPREAD_BASE ** (spread - 1) * FORM_BOOST[input.form];
}
