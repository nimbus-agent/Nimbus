// packages/gateway/src/connectors/connector-writes/messaging.ts
import { type ConnectorWriteRow, row } from "./types.ts";

export const MESSAGING_ROWS: readonly ConnectorWriteRow[] = [
  row("slack_message_post", "slack.message.post", "mesh", 2),
  row("slack_message_post_dm", "slack.message.post", "mesh", 2),
  row("teams_message_post", "teams.message.post", "mesh", 2),
  row("teams_message_post_chat", "teams.message.postChat", "mesh", 2),
];
