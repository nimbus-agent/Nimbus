// packages/gateway/src/connectors/connector-writes/messaging.ts
import { type ConnectorWriteRow, row, textField, withPreview } from "./types.ts";

export const MESSAGING_ROWS: readonly ConnectorWriteRow[] = [
  withPreview(row("slack_message_post", "slack.message.post", "mesh", 2), {
    target: "{channel}",
    summary: "Post a Slack message to {channel}",
    // The connector sends `thread_ts` only when it is a non-empty string.
    fields: [
      textField("text", "Message"),
      textField("thread_ts", "Thread", "(not set: a new message, not a thread reply)"),
    ],
  }),
  // With several comma-separated ids the connector opens one group DM.
  withPreview(row("slack_message_post_dm", "slack.message.post", "mesh", 2), {
    target: "{user_ids}",
    summary: "Send a Slack direct message to {user_ids}",
    fields: [textField("text", "Message")],
  }),
  // The connector's `postGraphMessage` defaults `contentType` to "text".
  withPreview(row("teams_message_post", "teams.message.post", "mesh", 2), {
    target: "{teamId}/{channelId}",
    summary: "Post a Teams channel message to {channelId}",
    fields: [textField("body", "Message"), textField("contentType", "Format", "text")],
  }),
  withPreview(row("teams_message_post_chat", "teams.message.postChat", "mesh", 2), {
    target: "{chatId}",
    summary: "Post a Teams chat message to {chatId}",
    fields: [textField("body", "Message"), textField("contentType", "Format", "text")],
  }),
  // Owner ruling: the preview says it posts as the bot. The connector sends
  // `allowed_mentions: { parse: ["users"] }` (pinned by discord-mentions.sync.test.ts).
  withPreview(row("discord_message_post", "discord.message.post", "mesh", 2), {
    target: "{channelId}",
    summary:
      "Post to Discord channel {channelId} as the bot, not as you; only user mentions notify",
    fields: [textField("content", "Message")],
  }),
];
