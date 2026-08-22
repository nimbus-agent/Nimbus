/**
 * Does this question look like one of the three negation predicates would have answered it?
 *
 * F21 — under `[llm] prefer_local`, `runTurn` takes `runViaLocalRouter`, which passes NO tools:
 * `LlmGenerateOptions` has no `tools` field at all, and the negation tools are registered on the
 * Mastra agent only. Every piece of the disclosure machinery lives downstream of a tool call, so
 * it fails silently along with it — `recordNegationDisclosure` is called BY a tool, so no tool
 * call means no record, `drainNegationDisclosures()` returns `[]`, and the appender cannot tell
 * "nothing to disclose" from "the disclosing component never ran".
 *
 * The result was the same question answered two opposite ways by one product. `nimbus query
 * --type deployment --no-downstream-incident` REFUSES with exit 1, because the substrate to
 * answer it is not indexed; `nimbus ask` replied "No downstream incidents found for any
 * deployment" — a sentence a reader takes as "I checked, there were none".
 *
 * WHY A KEYWORD MATCH, given this file otherwise argues against guessing: the alternative is
 * asking a model whether a question is negation-shaped, on the exact path where the model has no
 * tools and is already the component being distrusted. The cost of the two error directions is
 * also very asymmetric. A false positive appends one cautionary sentence to an answer that did
 * not need it. A false negative leaves the failure exactly as it is today. So this errs toward
 * firing, and the disclosure is worded to be true even when it fires on a question the predicates
 * would not have handled.
 *
 * This is the audit's option (1), which it explicitly warns is not the whole fix: giving the
 * local router real tool-calling (Ollama supports it, and `llama3.2` advertises `tools`) is
 * option (2), and it would make W6-B.2 real on this path rather than nominal. A disclosure that
 * permanently explains why a shipped feature does nothing is a worse resting place than either
 * end state — this is a floor, not a destination.
 */

/**
 * Phrases that indicate an absence question. Deliberately narrow: each is a construction that
 * asks for things NOT in a set, rather than any use of a negative word. "not sure what changed"
 * is a hedge, not a negation query, and matching it would make the disclosure noise.
 */
const NEGATION_PHRASES: readonly RegExp[] = [
  // "which PRs did not touch", "PRs that didn't touch", "haven't touched"
  /\b(did|does|do|has|have|had)(n't| not)\b/i,
  // "never reviewed", "never deployed"
  /\bnever\b/i,
  // "no downstream incident", "no incidents", "with no reviews"
  /\b(with |had |having )?no\s+\w+/i,
  // "without an incident", "without reviewing"
  /\bwithout\b/i,
  // "nobody reviewed", "no one has reviewed"
  /\b(nobody|no one|none of)\b/i,
  // "PRs not touching x", "deployments not correlated"
  /\bnot\s+(touch|touching|review|reviewing|reviewed|correlat|linked|covered)/i,
  // the flag names themselves, if a user pastes one into a question
  /--not-touching|--no-downstream-incident|--not-reviewed/i,
];

/**
 * The subjects the three predicates actually cover. Requiring one of these alongside a negation
 * phrase is what keeps "I don't know what this does" from triggering the disclosure: the question
 * has to be about the kind of thing a predicate could have answered.
 */
const NEGATION_SUBJECTS =
  /\b(pr|prs|pull request|pull requests|deploy|deploys|deployment|deployments|review|reviews|reviewed|reviewer|reviewers|incident|incidents|merge|merged|commit|commits|touch|touched|touching)\b/i;

export function isNegationShapedQuestion(input: string): boolean {
  const q = input.trim();
  if (q === "") return false;
  if (!NEGATION_SUBJECTS.test(q)) return false;
  return NEGATION_PHRASES.some((re) => re.test(q));
}

/**
 * What the reader is owed when the predicates could not run.
 *
 * States what DID happen rather than only what did not: the answer above came from unconstrained
 * generation over retrieved context, so a confident negative in it is not a verified absence. It
 * names the two surfaces that do verify, because "this answer may be wrong" without a route to a
 * right one is not much of a disclosure.
 */
export const NEGATION_TOOLS_UNAVAILABLE_LINE =
  "_Note: this looks like an absence question, and the local model has no tool access — " +
  "so the negation predicates were NOT consulted and nothing above was verified against the " +
  "index. A negative answer here is the model's, not a checked fact. Run `nimbus query` or " +
  "`nimbus people list` with the matching predicate for a verified answer or an honest refusal._";
