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

export type WhyRefInput = { ref: string; line?: number; prUrl?: never; itemUrl?: never };

/** The browser-viable arm: a pull request URL, no local checkout required. */
export type WhyPrInput = { prUrl: string; ref?: never; line?: never; itemUrl?: never };

/**
 * The second browser-viable arm: an indexed item that is NOT a pull request —
 * a Jira or Linear issue, a PagerDuty incident.
 *
 * Deliberately not a Confluence page. A page indexes as `type: "page"`, which
 * appears in neither `ITEM_LINKED_ENTITY_TYPES` nor `GRAPH_SYNC_BY_TYPE`, so it
 * has no `graph_entity` at all — and every lane on this arm answers from graph
 * edges. `resolveItemArm` treats "resolved, but no entity" as a miss for exactly
 * that reason, rather than returning a subject the lanes cannot answer about.
 */
export type WhyItemInput = { itemUrl: string; ref?: never; line?: never; prUrl?: never };

/**
 * Exactly one arm, never two. `agents.whyPeek` accepts only `WhyRefInput` — it
 * is line-level by nature and stays HTTP-excluded.
 */
export type WhyInput = WhyRefInput | WhyPrInput | WhyItemInput;

export function isWhyPrInput(input: WhyInput): input is WhyPrInput {
  return "prUrl" in input;
}

export function isWhyItemInput(input: WhyInput): input is WhyItemInput {
  return "itemUrl" in input;
}
