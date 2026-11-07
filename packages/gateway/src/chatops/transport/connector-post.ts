import type { RunChatopsTool } from "../chatops-tool-runner.ts";
import type { ChatCard, ChatPlatform } from "../types.ts";

const SLACK_CHAT_POST = "slack_chat_post";
const TEAMS_CHAT_POST = "teams_chat_post";
const SLACK_VIEWS_OPEN = "slack_views_open";

/**
 * The operational-post tool ids, for the I26 write predicate (`connectors/connector-write-registry.ts`).
 * Exported as a set so that predicate can refuse a federated peer naming one without naming the
 * literal itself — D17 confines these literals to the I23 reply surface, and D17 only governs where
 * the GATEWAY names them; it says nothing about which tool id a federated invoke may carry.
 */
export const CHATOPS_POST_TOOL_IDS: ReadonlySet<string> = new Set([
  SLACK_CHAT_POST,
  TEAMS_CHAT_POST,
  SLACK_VIEWS_OPEN,
]);

/**
 * The production `post()` dependency for the I23 reply surface (ReplyDispatcher /
 * ApprovalPresenter). This file is the ONLY gateway wiring site naming the connector post tools
 * (`slack_chat_post` / `teams_chat_post`) — enforced by static D17; destinations are always the
 * server-derived channel the caller resolved, never caller-supplied.
 *
 * `serviceUrlFor` resolves the Bot Framework serviceUrl recorded from the inbound activity for a
 * Teams conversation (replies must target the activity's regional endpoint).
 */
export function buildConnectorPost(
  runTool: RunChatopsTool,
  serviceUrlFor: (conversationId: string) => string | undefined,
): (platform: ChatPlatform, channelId: string, text: string, card?: ChatCard) => Promise<void> {
  return async (platform, channelId, text, card) => {
    if (platform === "slack") {
      await runTool("slack", SLACK_CHAT_POST, {
        channel: channelId,
        text,
        ...(card?.slackBlocks === undefined ? {} : { blocks: card.slackBlocks }),
      });
      return;
    }
    const serviceUrl = serviceUrlFor(channelId);
    await runTool(
      "teams",
      TEAMS_CHAT_POST,
      {
        conversationId: channelId,
        text,
        ...(card?.teamsAttachment === undefined ? {} : { attachments: [card.teamsAttachment] }),
      },
      serviceUrl === undefined ? undefined : { serviceUrl },
    );
  };
}

/**
 * The production `views.open` dependency for a typed-confirmation modal (Phase 9.7 D0c): the Slack
 * `slack_views_open` tool, opened with the one-time `trigger_id` of a Confirm click. Like
 * `buildConnectorPost`, this is an UNLEDGERED function: it may be called only as the argument of
 * `egress/chatops-egress.ts`'s `buildLedgeredConfirmModal` (static D17). The view is built by
 * `confirm-card.ts` from a fixed template, never from caller data.
 */
export function buildConnectorViewsOpen(
  runTool: RunChatopsTool,
): (triggerId: string, view: object) => Promise<void> {
  return async (triggerId, view) => {
    await runTool("slack", SLACK_VIEWS_OPEN, { trigger_id: triggerId, view });
  };
}
