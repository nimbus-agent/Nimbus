// packages/gateway/src/connectors/connector-writes/agent-door-legacy.ts
// The deprecation text of the agent door's window (Phase 28 AD3a-2a, D-7; owner rulings OR-AD-3 and
// OR-AD-9). A proposal the earlier act door accepted that the owner's per-door list would not is
// still accepted, flagged `legacy`, counted and warned about on four surfaces: the `capture.submit`
// reply, `approvals.list`/`approvals.get`, the approval prompt and `connector.writesStatus`. Those
// surfaces all take their text from here, so one test can pin that they agree. AD3b deletes this
// module, which fails that test on purpose.
//
// The text is FIXED. The only variables are an action type and a service, and both come from the
// write table (a matching row), never from request text.
import { serviceOf } from "../../engine/service-of.ts";
import { AGENT_DOOR_MAIL_SEND_TOOL_IDS, agentDoorRow } from "./agent-door.ts";

/** The line for one of the seven mail sends. */
export const LEGACY_MAIL_SEND_NOTICE =
  "Deprecated: outside agents will not be able to propose mail sends in a later release (drafts stay allowed). This proposal is accepted for now.";

/** The line for any other type the owner has not approved for agents by name. */
export function legacyUnapprovedNotice(actionType: string, service: string): string {
  return `Deprecated: ${actionType} is not approved for outside agents by name. It is accepted for now and will be refused in a later release. To keep it working run: nimbus connector writes enable ${service} --door agent`;
}

/** What `status` prints under the count: the command that ends the warning for every type that can be approved (not the mail sends). */
export const LEGACY_STATUS_COMMAND = "nimbus connector writes enable <service> --door agent";

/**
 * The deprecation line for one legacy proposal. A type that matches no write row (it cannot be a
 * legacy proposal, but the caller is not trusted to know that) gets a line that names nothing.
 */
export function legacyNoticeFor(actionType: string): string {
  const row = agentDoorRow(actionType);
  if (row === undefined) {
    return "Deprecated: this action type is not approved for outside agents by name. It is accepted for now and will be refused in a later release.";
  }
  if (AGENT_DOOR_MAIL_SEND_TOOL_IDS.has(row.toolId)) return LEGACY_MAIL_SEND_NOTICE;
  return legacyUnapprovedNotice(row.actionType, serviceOf(row.actionType));
}

/**
 * The header `approvals.list` and `approvals.get` carry when a legacy row is shown, and the line
 * `status` prints with its count.
 */
export const LEGACY_LIST_HEADER =
  "Some proposals below were accepted without being approved for outside agents by name. That is deprecated: a later release will refuse them, and the seven mail sends cannot be approved at all (drafts stay allowed). To keep the other types working run: nimbus connector writes enable <service> --door agent";
