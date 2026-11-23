import { isOwnerCodeServerServiceId } from "../../connectors/owner-code-server.ts";
import { serviceOf } from "../service-of.ts";

/**
 * I42: an owner-approved code server (a user-registered MCP server `mcp_*`, or an approved
 * extension `ext_*`) runs arbitrary owner-approved code, and its tools are not
 * enumerable ahead of time, so EVERY call to one needs the local owner's approval — derived from
 * the action TYPE alone (I3), never configurable, joined by OR so it only ever tightens.
 */
export function isUserMcpActionType(actionType: string): boolean {
  return isOwnerCodeServerServiceId(serviceOf(actionType));
}

/** The two owner approvals behind a standing rule (I55). */
export function isStandingRuleActionType(type: string): boolean {
  return type === "standing.rule.create" || type === "standing.rule.resume";
}

/**
 * The types whose prompt body is a purpose-built `payload.promptText`: it is printed by the prompt,
 * not repeated in structured details, and not stored in the audit row (which keeps the identifying
 * fields). One predicate for the three sites (`otherDisplayPayload`, `auditedBody`, `promptTextOf`).
 */
export function usesPromptText(type: string): boolean {
  return (
    type === "pack.install" ||
    isStandingRuleActionType(type) ||
    type === "workflow.import" ||
    type === "tool.model.invoke"
  );
}
