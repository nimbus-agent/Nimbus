/**
 * The write rows a cost report's channels would use (Phase 7, the Cost Pack), named in ONE place inside the row
 * table's own directory (static D20 confines every write tool id here), and the send door's full destination
 * check on a rendered report.
 *
 * `costReportDoorRefusal` builds the input the row would receive (the Teams and Outlook `contentType` from the
 * channel's format: `html` only for an html body, otherwise `text`) and runs the ONE messaging-destination check
 * both doors use (`messagingDestinationRefusal`): the ChatOps channel first, then the broadcast mention, then
 * remote content. Its answer is worded for the report owner, not for the model. Nothing is sent from here.
 */
import type { ChatopsPolicy } from "../../policy/types.ts";
import {
  BROADCAST_MENTION_REFUSAL,
  CHATOPS_CHANNEL_REFUSAL,
  messagingDestinationRefusal,
  REMOTE_CONTENT_REFUSAL,
} from "./model-write-refusals.ts";

export const COST_REPORT_POST_TOOL_IDS = Object.freeze({
  slack: "slack_message_post",
  teams: "teams_message_post",
  gmail: "gmail_draft_create",
  outlook: "outlook_draft_create",
} as const);

export type CostReportPostKind = keyof typeof COST_REPORT_POST_TOOL_IDS;

export interface CostReportPost {
  readonly kind: CostReportPostKind;
  readonly to: string | { readonly team: string; readonly channel: string } | readonly string[];
  readonly format: "text" | "markdown" | "html";
  readonly body: string;
  readonly subject: string | null;
}

const NO_POLICY =
  "the ChatOps policy could not be read, so no Slack or Teams post can be checked against its channels";
const WORDING: ReadonlyMap<string, string> = new Map([
  [
    CHATOPS_CHANNEL_REFUSAL,
    "the destination is a ChatOps channel, which only answers ChatOps commands",
  ],
  [
    BROADCAST_MENTION_REFUSAL,
    "the body notifies a whole channel, group or team (a broadcast mention)",
  ],
  [
    REMOTE_CONTENT_REFUSAL,
    "the body loads remote content (an external image, embed, frame or stylesheet) when it is opened",
  ],
]);

/** A draft's recipients as one line; a mail channel's `to` is an address or a list of them. */
const addresses = (to: CostReportPost["to"]): string =>
  typeof to === "string" ? to : (to as readonly string[]).join(", ");

/** The write row a report of `kind` posts with. */
export const costReportToolFor = (kind: CostReportPostKind): string =>
  COST_REPORT_POST_TOOL_IDS[kind];

/**
 * The input fields a `report` value may fill, per row (spec, Fixes 1): the body, and a draft's subject.
 * Every other field of these rows (channel, team, `to`, `cc`, `bcc`, thread, `contentType`) is a constant.
 */
export const REPORT_BODY_FIELDS: Readonly<
  Record<string, { readonly body: string; readonly subject: string | null }>
> = Object.freeze({
  slack_message_post: { body: "text", subject: null },
  teams_message_post: { body: "body", subject: null },
  gmail_draft_create: { body: "body", subject: "subject" },
  outlook_draft_create: { body: "body", subject: "subject" },
});

/** The input a row receives for a rendered post (the Teams/Outlook `contentType` is `html` only for html). */
export function costReportPostInput(p: CostReportPost): Record<string, unknown> {
  const contentType = p.format === "html" ? "html" : "text";
  if (p.kind === "slack") return { channel: p.to, text: p.body };
  if (p.kind === "teams") {
    const t = p.to as { team: string; channel: string };
    return { teamId: t.team, channelId: t.channel, body: p.body, contentType };
  }
  const mail = { to: addresses(p.to), subject: p.subject ?? "", body: p.body };
  return p.kind === "outlook" ? { ...mail, contentType } : mail;
}

/** What the send door would refuse for this rendered post, in report wording; null when it would pass. */
export function costReportDoorRefusal(
  p: CostReportPost,
  chatops: ChatopsPolicy | undefined,
): string | null {
  const refusal = messagingDestinationRefusal(
    COST_REPORT_POST_TOOL_IDS[p.kind],
    costReportPostInput(p),
    {
      chatops,
    },
  );
  if (refusal === undefined) return null;
  if (refusal === CHATOPS_CHANNEL_REFUSAL && chatops === undefined) return NO_POLICY;
  return WORDING.get(refusal) ?? refusal;
}
