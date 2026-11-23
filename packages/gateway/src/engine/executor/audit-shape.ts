import { createHash } from "node:crypto";
import { withoutTemplateText } from "../audit-bodies.ts";
import { withoutFileText } from "../audit-files.ts";
import { isAgentOrigin } from "../outside-origin.ts";
import type { AgentProposer, PlannedAction, WorkflowProvenance } from "../types.ts";
import { usesPromptText } from "./action-types.ts";
import { hasPlanText, omitPlanText } from "./consent-display.ts";

function omitPromptText(payload: Record<string, unknown>): Record<string, unknown> {
  const { promptText: _prompt, ...rest } = payload;
  return rest;
}

/** An action as the audit row records it: the proposer is projected to the door and the capture. */
type AuditedAction = Omit<PlannedAction, "proposer" | "userMcpCall"> & {
  proposer?: Pick<AgentProposer, "door" | "captureId" | "label" | "labelSource">;
  /** AD5a: an approved user-MCP call's definition hash, and nothing else of its facts. */
  userMcp?: { definitionSha256: string };
};

/**
 * Phase 28 AD1/AD4: an agent proposal's row names the door and the proposer: the capture (the
 * gateway's own id) and the client's own label with where it came from. The label is the client's
 * claim and every reader shows it as UNVERIFIED; the agent's summary stays out of the chain. The
 * projection comes BEFORE the payload, which the row's size cap may cut, and a stored label is at
 * most 100 units, so the four fields always fit the cap. Copied by name, never spread: nothing else
 * of the proposer reaches the row (static D49(c)).
 */
export function auditedAction(action: PlannedAction): AuditedAction {
  // AD5a: the call facts never reach the row. An approved call adds its definition hash after the
  // proposer; any other action (a model call, an owner call) gets no key at all,
  // so its row is byte-for-byte what it was.
  if (action.userMcpCall !== undefined) {
    const { userMcpCall, ...rest } = action;
    const projected = auditedProposer(rest);
    // An agent-origin action always has its proposer by here (the prompt refuses to build without
    // one), so the proposer test narrows the type and never selects a different row in practice.
    const { proposer } = projected;
    if (userMcpCall.approval === null || !isAgentOrigin(action) || proposer === undefined) {
      return projected;
    }
    const { type, proposer: _proposer, ...others } = projected;
    return {
      type,
      proposer,
      userMcp: { definitionSha256: userMcpCall.approval.definitionSha256 },
      ...others,
    };
  }
  return auditedProposer(action);
}

/** The proposer projection of {@link auditedAction}, for an action without call facts. */
function auditedProposer(action: Omit<PlannedAction, "userMcpCall">): AuditedAction {
  if (action.proposer === undefined) return auditedBody(action);
  const { proposer, ...rest } = action;
  const { type, ...others } = auditedBody(rest);
  return {
    type,
    proposer: {
      door: proposer.door,
      captureId: proposer.captureId,
      label: proposer.label,
      labelSource: proposer.labelSource,
    },
    ...others,
  };
}

/** The payload the audit row records: the identifying fields, without a rendered prompt body. */
function auditedBody(action: PlannedAction): PlannedAction {
  if (action.provenance !== undefined) {
    // SA2: the row names the workflow run; the field sources (for the standing-rule check) stay out.
    // The history comes BEFORE the payload, which the row's size cap may cut.
    const { fieldSources: _sources, ...history } = action.provenance;
    const { provenance: _own, ...rest } = action;
    const { type, ...others } = auditedBody(rest);
    return { type, provenance: history as WorkflowProvenance, ...others };
  }
  if (action.payload === undefined) return action;
  // The prompt text can run to many lines of pack content; the row keeps the identifying fields.
  if (usesPromptText(action.type)) {
    return { ...action, payload: omitPromptText(action.payload) };
  }
  // The rendered plan repeats `plan`, which the row keeps.
  if (hasPlanText(action)) return { ...action, payload: omitPlanText(action.payload) };
  // A multi-file write keeps its file count and size, never the file text (D1c); a CloudFormation
  // write its template's size and hash, never the template (D2).
  return withoutTemplateText(withoutFileText(action));
}

/**
 * SHA-256 (hex) of a bound write's injected values, the audit row's `boundValuesSha256`. The audit
 * row carries this, never the values, so what was dispatched can be reconciled with the connector's
 * own log. Canonical form, for reconcilers: the JSON of an ARRAY of `[key, value]` pairs, keys in
 * UTF-16 code-unit order (locale-independent, and no key is equal to another under it); an array
 * rather than an object, because `JSON.stringify` orders integer-like object keys numerically.
 */
export function boundValuesDigest(values: Readonly<Record<string, string>>): string {
  const pairs = Object.keys(values)
    .sort(byCodeUnit)
    .map((k) => [k, values[k]]);
  return createHash("sha256").update(JSON.stringify(pairs)).digest("hex");
}

/** UTF-16 code-unit order: the same on every machine, whatever its locale. Object keys are
 * distinct, so two keys never compare equal. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : 1;
}
