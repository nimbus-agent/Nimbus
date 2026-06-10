import type { RunChatopsTool } from "../chatops-tool-runner.ts";
import type { ChatPlatform } from "../types.ts";

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
      await runTool("slack", "slack_chat_post", { channel: channelId, text });
      return;
    }
    const serviceUrl = serviceUrlFor(channelId);
    await runTool(
      "teams",
      "teams_chat_post",
      { conversationId: channelId, text },
      serviceUrl === undefined ? undefined : { serviceUrl },
    );
  };
}
