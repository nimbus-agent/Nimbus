import pino from "pino";

import { agentRequestContext } from "./agent-request-context.ts";

const disclosureLog = pino({
  name: "negation-disclosure",
  level: process.env["NIMBUS_LOG_LEVEL"] ?? "info",
});

export type NegationDisclosureInput =
  | { kind: "refused"; tool: string; message: string; remediation: string }
  | { kind: "excluded"; tool: string; counts: ReadonlyArray<{ label: string; n: number }> };

/**
 * ONE definition of each disclosure sentence, read by the tool (which embeds it in its own
 * payload) and by the append site (which shows it to the user whatever the model did). The
 * `agents/_lib/brief-disclosures.ts` shape: one definition, two readers, so the two cannot drift.
 *
 * Returns `undefined` when there is nothing to disclose — an all-zero exclusion set means nothing
 * was withheld, and a line claiming "0 excluded" would imply a shortfall that did not happen.
 */
export function negationDisclosureLine(input: NegationDisclosureInput): string | undefined {
  if (input.kind === "refused") {
    return `${input.tool} could not be verified: ${input.message}. ${input.remediation}.`;
  }
  const parts = input.counts
    .filter((c) => c.n > 0)
    .map((c) => `${String(c.n)} excluded (${c.label})`);
  if (parts.length === 0) {
    return undefined;
  }
  return `${input.tool}: ${parts.join("; ")} — absent from the answer above rather than counted as matching.`;
}

/**
 * Push a sentence onto the current turn's store. A missing store is NOT an error: the tool has
 * already embedded the same sentence in its result payload (spec § 5.1.1), so the guarantee
 * degrades to "the model saw it" rather than to silence. It is logged because a turn that
 * silently lost its context is worth knowing about.
 */
export function recordNegationDisclosure(line: string): void {
  const store = agentRequestContext.getStore();
  if (store === undefined) {
    disclosureLog.warn(
      { line },
      "negation disclosure not recorded: no agent request context on this turn",
    );
    return;
  }
  const arr = store.negationDisclosures ?? [];
  arr.push(line);
  store.negationDisclosures = arr;
}

/**
 * Read AND CLEAR. Draining rather than reading is what stops a store reused within one dispatch
 * frame — a sub-agent turn, a retry — from re-emitting a disclosure the user has already seen.
 */
export function drainNegationDisclosures(): string[] {
  const arr = agentRequestContext.getStore()?.negationDisclosures;
  if (arr === undefined || arr.length === 0) {
    return [];
  }
  return arr.splice(0, arr.length);
}
