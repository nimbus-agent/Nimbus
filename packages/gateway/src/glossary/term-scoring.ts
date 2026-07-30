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

export function scoreTerm(input: {
  docFreq: number;
  serviceSpread: number;
  form: CandidateForm;
}): number {
  if (input.docFreq <= 0) return 0;
  const spread = Math.max(1, input.serviceSpread);
  return Math.log1p(input.docFreq) * (1 + 0.5 * (spread - 1)) * FORM_BOOST[input.form];
}
