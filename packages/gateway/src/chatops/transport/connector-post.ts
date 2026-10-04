import type { RunChatopsTool } from "../chatops-tool-runner.ts";
import type { ChatPlatform } from "../types.ts";

const SLACK_CHAT_POST = "slack_chat_post";
const TEAMS_CHAT_POST = "teams_chat_post";

/**
 * The operational-post tool ids, for the I26 write predicate (`connectors/connector-write-registry.ts`).
 * Exported as a set so that predicate can refuse a federated peer naming one without naming the
 * literal itself — D17 confines these literals to the I23 reply surface, and D17 only governs where
 * the GATEWAY names them; it says nothing about which tool id a federated invoke may carry.
 */
export const CHATOPS_POST_TOOL_IDS: ReadonlySet<string> = new Set([
  SLACK_CHAT_POST,
  TEAMS_CHAT_POST,
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
): (platform: ChatPlatform, channelId: string, text: string) => Promise<void> {
  return async (platform, channelId, text) => {
    if (platform === "slack") {
      await runTool("slack", SLACK_CHAT_POST, { channel: channelId, text });
      return;
    }
    const serviceUrl = serviceUrlFor(channelId);
    await runTool(
      "teams",
      TEAMS_CHAT_POST,
      { conversationId: channelId, text },
      serviceUrl === undefined ? undefined : { serviceUrl },
    );
  };
}
