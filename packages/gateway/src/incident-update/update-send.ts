import type { Database } from "bun:sqlite";

import { connectorWriteRowByToolId } from "../connectors/connector-write-registry.ts";
import { messagingDestinationRefusal } from "../connectors/connector-writes/model-write-refusals.ts";
import { UPDATE_POST_TOOL_IDS } from "../connectors/connector-writes/update-post-rows.ts";
import type { ActionResult, PlannedAction } from "../engine/types.ts";
import { mintIncidentLink } from "../incident/incident-link-mint.ts";
import type { ChatopsPolicy } from "../policy/types.ts";

/**
 * The incident update send (Phase 10 IC9b, spec § 5.9): the owner's update text becomes ONE Slack channel message
 * (`slack_message_post`) or ONE Teams channel message (`teams_message_post`, a `text` body) through the EXISTING
 * row and the executor's `execute()`, as the LOCAL OWNER's own action: no origin, no proposer, no provenance, the
 * incident link (so the audit row, the egress row and the timeline name the record), the typed preview, the
 * consent gate on the owner's own connection. This module never dispatches and never answers a prompt; a denial
 * posts nothing.
 *
 * Before any prompt, the B1 messaging rules the spec names apply to the exact input: a post to a channel ChatOps
 * listens on, a broadcast mention, remote content (`messagingDestinationRefusal`, the one implementation both
 * doors call). ChatOps bindings that cannot be read refuse (the B1 rule: the ChatOps channels cannot be ruled
 * out). The text is capped. Outcomes are values, never thrown, so the CLI can say exactly what happened.
 */

export type UpdateDestination =
  | { readonly platform: "slack"; readonly channel: string }
  | { readonly platform: "teams"; readonly teamId: string; readonly channelId: string };

export type SendOutcome =
  | { readonly outcome: "sent" }
  | { readonly outcome: "refused"; readonly code: string; readonly reason: string }
  | { readonly outcome: "denied"; readonly reason: string }
  /**
   * `execute()` threw. It returns a `rejected` result for every refusal before the dispatch, so a throw may come
   * AFTER it (the dispatcher's timeout while the tool call can still complete, an oversized reply): the message
   * may have been posted, and a retry could post it twice.
   */
  | { readonly outcome: "uncertain"; readonly reason: string };

export type SendDeps = {
  readonly db: Database;
  /** The owner's push executor (`buildOwnerPushExecutor`): all a send needs of it is `execute`. */
  readonly executor: { execute(action: PlannedAction): Promise<ActionResult> };
  /** The ChatOps bindings of the LIVE enforced policy; `undefined` (or a throw) refuses the send. */
  readonly chatops: () => ChatopsPolicy | undefined;
};

/** Slack's `text` limit is 40,000 characters; an update is a short message, so the cap is far below it. */
export const UPDATE_TEXT_MAX = 12_000;
const REASON_MAX = 300;

function failureReason(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  // Control and invisible characters out, cut: the text may carry a provider's words.
  const flat = text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trim();
  return flat.length > REASON_MAX ? `${flat.slice(0, REASON_MAX)}…` : flat;
}

function rowFor(dest: UpdateDestination): { toolId: string; actionType: string } {
  const toolId = UPDATE_POST_TOOL_IDS[dest.platform];
  const row = connectorWriteRowByToolId(toolId);
  if (row === undefined) throw new Error(`"${toolId}" is not a connector write tool`);
  return { toolId: row.toolId, actionType: row.actionType };
}

function inputFor(dest: UpdateDestination, text: string): Record<string, unknown> {
  return dest.platform === "slack"
    ? { channel: dest.channel, text }
    : { teamId: dest.teamId, channelId: dest.channelId, body: text, contentType: "text" };
}

export async function sendIncidentUpdate(
  deps: SendDeps,
  recordId: string,
  dest: UpdateDestination,
  text: string,
): Promise<SendOutcome> {
  // The link names a record that exists and the version it holds NOW (static D46(e)); a missing record throws
  // the incident readers' own typed error before anything else.
  const link = mintIncidentLink(deps.db, recordId);
  if (text.trim() === "") {
    return { outcome: "refused", code: "ERR_INCIDENT_UPDATE_EMPTY", reason: "the update is empty" };
  }
  if (text.length > UPDATE_TEXT_MAX) {
    return {
      outcome: "refused",
      code: "ERR_INCIDENT_UPDATE_TOO_LONG",
      reason: `the update is longer than ${String(UPDATE_TEXT_MAX)} characters`,
    };
  }
  const row = rowFor(dest);
  const input = inputFor(dest, text);
  let chatops: ChatopsPolicy | undefined;
  try {
    chatops = deps.chatops();
  } catch {
    chatops = undefined;
  }
  const refused = messagingDestinationRefusal(row.toolId, input, { chatops });
  if (refused !== undefined) {
    return { outcome: "refused", code: "ERR_INCIDENT_UPDATE_REFUSED", reason: refused };
  }
  const action: PlannedAction = {
    type: row.actionType,
    incident: link,
    payload: { mcpToolId: row.toolId, input },
  };
  try {
    const out = await deps.executor.execute(action);
    if (out.status === "ok") return { outcome: "sent" };
    return { outcome: "denied", reason: failureReason(out.reason) };
  } catch (e) {
    return { outcome: "uncertain", reason: failureReason(e) };
  }
}
