// packages/gateway/src/connectors/connector-writes/agent-door.ts
// The agent door's routing and eligibility facts (Phase 28 AD3a-1; spec 2026-11-13 § 7.3, D-AD-5):
// which write ROW an outside agent's action type resolves to, which rows the owner can approve for
// agents now (and why each other row cannot be), and whether policy lets the door exist at all.
//
// `agentOffered` (AD3a-2a) is the predicate itself: the conditions both doors share, the door's own
// approved set (V97), "not suspended", policy, and the scope and Obsidian rules. It is pure over the
// facts it is given; `agent-door-runtime.ts` reads those facts afresh on every call. The capture gate and
// the act wiring call it through that runtime (invariant I58).

import { MCP_ACTION_CAPABILITY } from "../../mcp-sink/capture-capability.ts";
import type { EnforcedPolicy } from "../../policy/policy-gate.ts";
import { mcpClientToolKey } from "../lazy-mesh/tool-map.ts";
import { definitionSha256 } from "./definition-hash.ts";
import type { DoorApproval } from "./door-approval-store.ts";
import {
  type ModelWriteEnablement,
  OBSIDIAN_APPEND_TOOL_ID,
  writesEnabledBy,
} from "./enablement-store.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { listedEntryDeclaresPreviewKeys } from "./listed-support.ts";
import { isModelOfferableRow, MODEL_NEVER_OFFERED_REASONS } from "./model-offerable.ts";
import { isConnectorWriteModelAccessEnabled } from "./model-write-capability.ts";
import { enabledAndOfferable, scopeAvailable } from "./model-write-source.ts";
import { scopeGatedReason } from "./scope-gated.ts";
import type { ConnectorWriteRow, ConnectorWriteWave } from "./types.ts";

/**
 * An action type is not a row: `slack.message.post` names both `slack_message_post` and
 * `slack_message_post_dm`. For a type with several rows an agent reaches the one named here (the same
 * row `PROPOSABLE_WRITE_TOOLS` routes to), so the Slack DM row cannot be reached by an agent
 * (OR-AD-10, a stated exception to model-door parity).
 */
export const AGENT_DOOR_TYPE_TIEBREAK: Readonly<Record<string, string>> = Object.freeze({
  "slack.message.post": "slack_message_post",
});

/**
 * The seven mail sends (OR-W34-1, OR-B3w-1): never offered to an agent, but accepted during the
 * deprecation window with a warning of their own (OR-AD-3, OR-AD-9). A test pins that this set is
 * exactly the rows of `MODEL_NEVER_OFFERED_REASONS` whose reason is the mail-send one.
 */
export const AGENT_DOOR_MAIL_SEND_TOOL_IDS: ReadonlySet<string> = Object.freeze(
  new Set([
    "gmail_message_send",
    "gmail_draft_send",
    "fastmail_mail_send",
    "imap_mail_send",
    "protonmail_mail_send",
    "apple_mail_send",
    "outlook_mail_send",
  ]),
);

/** The one row an agent's proposal of `actionType` runs, or `undefined` when none can be named. */
export function agentDoorRow(
  actionType: string,
  rows: readonly ConnectorWriteRow[] = CONNECTOR_WRITE_ROWS,
): ConnectorWriteRow | undefined {
  const ofType = rows.filter((r) => r.actionType === actionType);
  if (ofType.length <= 1) return ofType[0];
  const tie = Object.hasOwn(AGENT_DOOR_TYPE_TIEBREAK, actionType)
    ? AGENT_DOOR_TYPE_TIEBREAK[actionType]
    : undefined;
  return tie === undefined ? undefined : ofType.find((r) => r.toolId === tie);
}

/** What `agentApprovableRows` needs from the outside world; every member is read by the caller. */
export interface AgentApprovableContext {
  /** Test seam; production uses the write table. */
  readonly rows?: readonly ConnectorWriteRow[];
  /** The service's raw listing keyed `mcpClientToolKey(service, toolId)`, or `undefined` if none. */
  readonly listed: Readonly<Record<string, unknown>> | undefined;
  /** The owner's approved Terraform directories (V85); empty means the apply has none to name. */
  readonly approvedWorkdirs: readonly string[];
  /** The owner's approved Kubernetes (context, namespace) pairs (V86). */
  readonly approvedK8sPairs: ReadonlyArray<{
    readonly context: string;
    readonly namespace: string;
  }>;
  /** Credential scopes per service, for the scope-gated writes (see `scope-gated.ts`). */
  readonly grantedScopes?: Readonly<Record<string, string | undefined>>;
  /** Whether the model-door approval of the Obsidian append exists (it is the sandbox write grant). */
  readonly obsidianModelGrant: boolean;
}

export type AgentApprovableRow =
  | {
      readonly row: ConnectorWriteRow;
      readonly state: "approvable";
      /** The hash of the listing entry that was read: what the approval would store. */
      readonly definitionSha256: string;
    }
  | { readonly row: ConnectorWriteRow; readonly state: "not_approvable"; readonly reason: string };

const NOT_OFFERABLE_REASON =
  "not ready to be offered: it has no typed preview, or no before-state and confirmation text for Wave 4";
const NOT_ROUTABLE_REASON =
  "an agent cannot propose this write: its action type is reached through another tool";
const UNLISTED_ALL_REASON = "the connector's tools could not be listed";
const UNLISTED_ONE_REASON = "the connector does not list this tool";
const DRIFTED_REASON =
  "the connector's schema no longer declares an input the write's preview shows";
const UNREADABLE_REASON = "the connector lists this tool but its input schema cannot be read";
const NO_DIRECTORY_REASON = "no approved directory or Kubernetes context for it yet";
const OBSIDIAN_REASON =
  "approve it for the model first: that approval is the one thing that lets the Obsidian sandbox write";

/** The fixed reason a row cannot be approved for agents, or `undefined` when no static fact stops it. */
function staticReason(row: ConnectorWriteRow, ctx: AgentApprovableContext): string | undefined {
  if (Object.hasOwn(MODEL_NEVER_OFFERED_REASONS, row.toolId)) {
    return MODEL_NEVER_OFFERED_REASONS[row.toolId];
  }
  if (!isModelOfferableRow(row)) return NOT_OFFERABLE_REASON;
  const scope = scopeGatedReason(row.toolId, ctx.grantedScopes);
  if (scope !== undefined) return scope;
  if (agentDoorRow(row.actionType, ctx.rows ?? CONNECTOR_WRITE_ROWS) !== row) {
    return NOT_ROUTABLE_REASON;
  }
  if (!scopeAvailable(row, ctx.approvedWorkdirs.length > 0, ctx.approvedK8sPairs.length > 0)) {
    return NO_DIRECTORY_REASON;
  }
  if (row.toolId === OBSIDIAN_APPEND_TOOL_ID && !ctx.obsidianModelGrant) return OBSIDIAN_REASON;
  return undefined;
}

function classify(
  service: string,
  row: ConnectorWriteRow,
  ctx: AgentApprovableContext,
): AgentApprovableRow {
  const reason = staticReason(row, ctx);
  if (reason !== undefined) return { row, state: "not_approvable", reason };
  if (ctx.listed === undefined)
    return { row, state: "not_approvable", reason: UNLISTED_ALL_REASON };
  const key = mcpClientToolKey(service, row.toolId);
  if (!Object.hasOwn(ctx.listed, key)) {
    return { row, state: "not_approvable", reason: UNLISTED_ONE_REASON };
  }
  const sha = definitionSha256(row.toolId, ctx.listed[key]);
  if (sha === undefined) return { row, state: "not_approvable", reason: UNREADABLE_REASON };
  // Parity with the model door (`listedEntryFor`): a row whose typed preview names an input the
  // listed schema does not declare would show the owner a prompt that cannot match the call.
  if (!listedEntryDeclaresPreviewKeys(row, ctx.listed[key])) {
    return { row, state: "not_approvable", reason: DRIFTED_REASON };
  }
  return { row, state: "approvable", definitionSha256: sha };
}

/**
 * Every row the owner's enable of `service` up to `maxWave` covers, each either approvable for agents
 * now (with the hash of its listing) or not, with a fixed reason. Pure over its inputs.
 */
export function agentApprovableRows(
  service: string,
  maxWave: ConnectorWriteWave,
  ctx: AgentApprovableContext,
): readonly AgentApprovableRow[] {
  return writesEnabledBy(service, maxWave, ctx.rows ?? CONNECTOR_WRITE_ROWS).map((row) =>
    classify(service, row, ctx),
  );
}

/**
 * Whether policy lets the agent door exist: BOTH the connector-write capability (shared with the
 * model door) and the MCP act capability must be on in the RESOLVED policy (I22). Fail closed:
 * `undefined` is false.
 */
export function agentDoorPolicyAllows(
  enforced: Pick<EnforcedPolicy, "capabilitiesDisabled"> | undefined,
): boolean {
  return (
    isConnectorWriteModelAccessEnabled(enforced) &&
    enforced !== undefined &&
    !enforced.capabilitiesDisabled.has(MCP_ACTION_CAPABILITY)
  );
}

/** The facts {@link agentOffered} decides from; the caller reads every one of them at the call. */
export interface AgentOfferFacts {
  /** The shared enablement row (V83) of the row's service, or `undefined`. */
  readonly enablement: Pick<ModelWriteEnablement, "service" | "maxWave"> | undefined;
  /** The owner's agent-door approval of THIS tool (V97), or `undefined`. */
  readonly approval: Pick<DoorApproval, "suspendedAt"> | undefined;
  /** The LIVE resolved policy; `undefined` (unreadable) refuses. */
  readonly enforced: Pick<EnforcedPolicy, "capabilitiesDisabled"> | undefined;
  /** At least one approved Terraform directory (V85). */
  readonly hasWorkdir: boolean;
  /** At least one approved Kubernetes (context, namespace) pair (V86). */
  readonly hasK8sPair: boolean;
  /** The model-door approval of the Obsidian append (it is the sandbox's write grant, OR-AD-12). */
  readonly obsidianModelGrant: boolean;
  /** Credential scopes per service, for the scope-gated writes; absent makes no claim. */
  readonly grantedScopes?: Readonly<Record<string, string | undefined>>;
  /** Test seam; production uses the write table. */
  readonly rows?: readonly ConnectorWriteRow[];
}

/**
 * Whether an outside agent may be offered `row` now (spec § 7.3, D-AD-5, invariant I58), as an
 * ordered list of named steps, each of which alone refuses:
 *  1. the shared conditions (the service is enabled, the row's wave is at or below the shared wave,
 *     the row is offerable at all): the SAME function the model door uses;
 *  2. the action type routes to THIS row (so the Slack DM row is never reachable, OR-AD-10);
 *  3. the owner approved this tool for agents by name, and the approval is not suspended;
 *  4. policy: both `mcp_action` and `connector_write_model_access` are on, fail closed;
 *  5. a directory-scoped row (the Terraform apply, every Kubernetes row) has its scope;
 *  6. a scope-gated write's credential holds its scope;
 *  7. the Obsidian append only while its model-door approval stands.
 */
export function agentOffered(row: ConnectorWriteRow, facts: AgentOfferFacts): boolean {
  if (!enabledAndOfferable(facts.enablement, row)) return false;
  if (agentDoorRow(row.actionType, facts.rows ?? CONNECTOR_WRITE_ROWS) !== row) return false;
  if (facts.approval === undefined || facts.approval.suspendedAt !== null) return false;
  if (!agentDoorPolicyAllows(facts.enforced)) return false;
  if (!scopeAvailable(row, facts.hasWorkdir, facts.hasK8sPair)) return false;
  if (scopeGatedReason(row.toolId, facts.grantedScopes) !== undefined) return false;
  return row.toolId !== OBSIDIAN_APPEND_TOOL_ID || facts.obsidianModelGrant;
}
