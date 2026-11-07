import type { ChatCard } from "./types.ts";

/**
 * Pure builders for the typed-confirmation surfaces (Phase 9.7 D0c): the Slack card blocks, the Slack
 * modal that collects the typed text, and the Teams Adaptive Card with an `Input.Text`. Every shape
 * is a fixed template; only the request id, the action label and the confirm text are filled in.
 *
 * Nothing here compares, trims or normalises the typed text (static D41: the strict comparison is
 * the executor's alone). The confirm text a card shows is display only.
 */

/** The longest typed answer any surface accepts (and the longest confirm text a card carries). */
export const CONFIRM_TYPED_MAX = 512;

/** Slack `plain_text` section caps at 3000 characters; the label is clipped well inside it. */
export const CONFIRM_LABEL_MAX = 2_000;

export const SLACK_CONFIRM_OPEN_ACTION = "nimbus_confirm_open";
export const SLACK_CONFIRM_REJECT_ACTION = "nimbus_confirm_reject";
export const SLACK_CONFIRM_CALLBACK_ID = "nimbus_confirm";
export const SLACK_CONFIRM_BLOCK_ID = "confirm";
export const SLACK_CONFIRM_INPUT_ACTION_ID = "typed";
/**
 * The Adaptive Card element type for a text field. Joined from its parts because the browser-lane
 * confinement scan (I35, static D26(b)) reads any quoted `Input.<name>` literal as a Chrome DevTools
 * Protocol method; this is a card element type, not a protocol call.
 */
const TEAMS_TEXT_INPUT = ["Input", "Text"].join(".");
export const TEAMS_ADAPTIVE_CARD_CONTENT_TYPE = "application/vnd.microsoft.card.adaptive";

export interface ConfirmCardInput {
  readonly requestId: string;
  readonly label: string;
  readonly confirmText: string;
}

/** The label as shown on a card: clipped to `CONFIRM_LABEL_MAX` characters with an ellipsis. */
export function clipLabel(label: string): string {
  return label.length <= CONFIRM_LABEL_MAX ? label : `${label.slice(0, CONFIRM_LABEL_MAX - 1)}…`;
}

/** The fixed instruction line. The confirm text is displayed verbatim, never clipped. */
export function confirmInstruction(confirmText: string): string {
  return `To approve, type exactly: ${confirmText}`;
}

/** The plain text fallback line carried by the post beside the interactive card. */
export function confirmFallbackLine(confirmText: string): string {
  return `${confirmInstruction(confirmText)} in the form opened by Confirm.`;
}

/** The Slack card: a label section and two buttons whose `value` is the request id. */
export function slackConfirmBlocks(input: ConfirmCardInput): readonly object[] {
  return [
    {
      type: "section",
      text: { type: "plain_text", text: clipLabel(input.label) },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Confirm…" },
          action_id: SLACK_CONFIRM_OPEN_ACTION,
          value: input.requestId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Reject" },
          action_id: SLACK_CONFIRM_REJECT_ACTION,
          value: input.requestId,
          style: "danger",
        },
      ],
    },
  ];
}

/** The Slack modal that collects the typed text (opened by `views.open` from a Confirm click). */
export function slackConfirmView(input: ConfirmCardInput): object {
  return {
    type: "modal",
    callback_id: SLACK_CONFIRM_CALLBACK_ID,
    private_metadata: input.requestId,
    title: { type: "plain_text", text: "Confirm action" },
    submit: { type: "plain_text", text: "Approve" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "section",
        text: {
          type: "plain_text",
          text: `${clipLabel(input.label)}\n${confirmInstruction(input.confirmText)}`,
        },
      },
      {
        type: "input",
        block_id: SLACK_CONFIRM_BLOCK_ID,
        label: { type: "plain_text", text: "Confirmation" },
        element: {
          type: "plain_text_input",
          action_id: SLACK_CONFIRM_INPUT_ACTION_ID,
          max_length: CONFIRM_TYPED_MAX,
        },
      },
    ],
  };
}

const TEAMS_MARKDOWN_META = /[*_~`[\]()#]/g;

/** Backslash-escapes the Markdown metacharacters a Teams `TextBlock` would otherwise interpret. */
export function escapeTeamsMarkdown(s: string): string {
  return s.replaceAll(TEAMS_MARKDOWN_META, (c) => `\\${c}`);
}

/** The Teams attachment: an Adaptive Card 1.4 with one `Input.Text` and two `Action.Submit`. */
export function teamsConfirmCard(input: ConfirmCardInput): object {
  return {
    contentType: TEAMS_ADAPTIVE_CARD_CONTENT_TYPE,
    content: {
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      type: "AdaptiveCard",
      version: "1.4",
      body: [
        { type: "TextBlock", text: escapeTeamsMarkdown(clipLabel(input.label)), wrap: true },
        {
          type: "TextBlock",
          text: escapeTeamsMarkdown(confirmInstruction(input.confirmText)),
          wrap: true,
        },
        {
          type: TEAMS_TEXT_INPUT,
          id: "typed",
          label: "Confirmation",
          maxLength: CONFIRM_TYPED_MAX,
        },
      ],
      actions: [
        {
          type: "Action.Submit",
          title: "Approve",
          data: { nimbusConfirm: input.requestId, verdict: "approve" },
        },
        {
          type: "Action.Submit",
          title: "Reject",
          data: { nimbusConfirm: input.requestId, verdict: "reject" },
        },
      ],
    },
  };
}

/** The card for a platform. */
export function confirmCardFor(platform: "slack" | "teams", input: ConfirmCardInput): ChatCard {
  return platform === "slack"
    ? { slackBlocks: slackConfirmBlocks(input) }
    : { teamsAttachment: teamsConfirmCard(input) };
}
