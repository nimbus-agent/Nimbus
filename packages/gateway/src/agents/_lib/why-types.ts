/**
 * Why-lens types.
 *
 * The result types now live in `@nimbus-dev/sdk` (promoted in step 2 / sdk
 * 1.6.0) so the gateway, CLI and `@nimbus-dev/client` share one definition.
 * Re-exported here via `findings.ts` (the gateway's SDK shim) so existing
 * gateway imports keep working unchanged. `WhyInput` stays local: it is the
 * request-params shape, not a shared result type (params are client-local for
 * every agent).
 */
export type { WhyBrief, WhyFinding, WhyLane, WhyPeek, WhySubject } from "./findings.ts";

export type WhyRefInput = { ref: string; line?: number };

/** The browser-viable arm: a pull request URL, no local checkout required. */
export type WhyPrInput = { prUrl: string };

/**
 * Exactly one arm, never both. `agents.whyPeek` accepts only `WhyRefInput` — it
 * is line-level by nature and stays HTTP-excluded.
 */
export type WhyInput = WhyRefInput | WhyPrInput;

export function isWhyPrInput(input: WhyInput): input is WhyPrInput {
  return "prUrl" in input;
}
