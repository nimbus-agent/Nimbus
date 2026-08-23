import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
  type McpListResult,
  putOptionalBoolean,
  putOptionalNonEmptyString,
  requireProcessEnv,
} from "../../shared/mcp-tool-kit.ts";

type SlackApiRecord = Record<string, unknown>;

async function slackApi(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; json: SlackApiRecord; text: string }> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, json: {}, text };
  }
  const json =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as SlackApiRecord)
      : {};
  const okField = json["ok"];
  return { ok: okField === true && res.ok, json, text };
}

async function slackInvokeJsonWithToken(
  token: string,
  method: string,
  body: Record<string, unknown>,
  errorLabel: string,
): Promise<McpListResult> {
  const res = await slackApi(token, method, body);
  if (!res.ok) {
    throw new Error(`${errorLabel}: ${res.text.slice(0, 400)}`);
  }
  return jsonResult(res.json);
}

async function slackInvokeJson(
  method: string,
  body: Record<string, unknown>,
  errorLabel: string,
): Promise<McpListResult> {
  return slackInvokeJsonWithToken(
    requireProcessEnv("SLACK_USER_ACCESS_TOKEN"),
    method,
    body,
    errorLabel,
  );
}

const slackConversationsHistorySchema = z.object({
  channel: z.string().min(1),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
  oldest: z.string().optional(),
  inclusive: z.boolean().optional(),
});

type SlackConversationsHistoryParsed = z.infer<typeof slackConversationsHistorySchema>;

function buildConversationsHistoryBody(
  parsed: SlackConversationsHistoryParsed,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    channel: parsed.channel,
    limit: parsed.limit ?? 50,
  };
  putOptionalNonEmptyString(body, "cursor", parsed.cursor);
  putOptionalNonEmptyString(body, "oldest", parsed.oldest);
  putOptionalBoolean(body, "inclusive", parsed.inclusive);
  return body;
}

const server = new McpServer({ name: "nimbus-slack", version: "0.1.0" });

const registerSimpleTool = createRegisterSimpleTool(server);

import { createWriteToolRegistrar } from "../../shared/consent-kit.ts";

const reg = createZodToolRegistrar(registerSimpleTool);

/**
 * Every MUTATING slack tool goes through here. Outside the gateway this adds the
 * consent gate, the write-scope allow-list, the mutation budget and the audit record; inside
 * the gateway it is a pass-through, because executor.ts (I2) is the gate there.
 */
const registerWriteTool = createWriteToolRegistrar(server, {
  connector: "slack",
  scopeEnv: "NIMBUS_MCP_SLACK_WRITE_SCOPE",
  scopeKinds: ["channel"],
});

const slackChannelListSchema = z.object({
  types: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});

reg(
  "slack_channel_list",
  "List channels the user is a member of (public, private, mpim, im).",
  slackChannelListSchema,
  async (parsed) => {
    const body: Record<string, unknown> = {
      types: parsed.types ?? "public_channel,private_channel,mpim,im",
      limit: parsed.limit ?? 200,
      exclude_archived: true,
    };
    putOptionalNonEmptyString(body, "cursor", parsed.cursor);
    return slackInvokeJson("conversations.list", body, "Slack conversations.list");
  },
);

reg(
  "slack_channel_history",
  "Fetch message history for a channel, DM, or mpim.",
  slackConversationsHistorySchema,
  async (parsed) =>
    slackInvokeJson(
      "conversations.history",
      buildConversationsHistoryBody(parsed),
      "Slack conversations.history",
    ),
);

const slackThreadRepliesSchema = z.object({
  channel: z.string().min(1),
  ts: z.string().min(1),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});

reg(
  "slack_thread_replies",
  "Fetch replies in a thread (channel + thread parent ts).",
  slackThreadRepliesSchema,
  async (parsed) => {
    const body: Record<string, unknown> = {
      channel: parsed.channel,
      ts: parsed.ts,
      limit: parsed.limit ?? 50,
    };
    putOptionalNonEmptyString(body, "cursor", parsed.cursor);
    return slackInvokeJson("conversations.replies", body, "Slack conversations.replies");
  },
);

const slackDmListSchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});

reg(
  "slack_dm_list",
  "List direct message conversations (im + mpim).",
  slackDmListSchema,
  async (parsed) => {
    const body: Record<string, unknown> = {
      types: "im,mpim",
      limit: parsed.limit ?? 200,
      exclude_archived: true,
    };
    putOptionalNonEmptyString(body, "cursor", parsed.cursor);
    return slackInvokeJson("conversations.list", body, "Slack dm list");
  },
);

reg(
  "slack_dm_history",
  "Fetch DM / mpim history (same as channel history; convenience alias).",
  slackConversationsHistorySchema,
  async (parsed) =>
    slackInvokeJson(
      "conversations.history",
      buildConversationsHistoryBody(parsed),
      "Slack dm history",
    ),
);

const slackUserListSchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});

reg(
  "slack_user_list",
  "List users in the workspace (paginated).",
  slackUserListSchema,
  async (parsed) => {
    const body: Record<string, unknown> = { limit: parsed.limit ?? 100 };
    putOptionalNonEmptyString(body, "cursor", parsed.cursor);
    return slackInvokeJson("users.list", body, "Slack users.list");
  },
);

const slackUserGetSchema = z.object({ user: z.string().min(1) });

reg("slack_user_get", "Get a single user profile by ID.", slackUserGetSchema, async (parsed) =>
  slackInvokeJson("users.info", { user: parsed.user }, "Slack users.info"),
);

const slackSearchSchema = z.object({
  query: z.string().min(1),
  count: z.number().int().min(1).max(100).optional(),
  page: z.number().int().min(1).optional(),
  sort: z.enum(["timestamp", "score"]).optional(),
  sort_dir: z.enum(["asc", "desc"]).optional(),
});

reg("slack_search", "Search messages (workspace search).", slackSearchSchema, async (parsed) => {
  const body: Record<string, unknown> = {
    query: parsed.query,
    count: parsed.count ?? 20,
    page: parsed.page ?? 1,
  };
  if (parsed.sort !== undefined) {
    body["sort"] = parsed.sort;
  }
  if (parsed.sort_dir !== undefined) {
    body["sort_dir"] = parsed.sort_dir;
  }
  return slackInvokeJson("search.messages", body, "Slack search.messages");
});

const slackMessagePostSchema = z.object({
  channel: z.string().min(1),
  text: z.string().min(1),
  thread_ts: z.string().optional(),
});

registerWriteTool(
  "slack_message_post",
  {
    mutates: "slack.message.post",
    recoverable: true,
    scopeTargetOf: (p) => ({ kind: "channel", value: p.channel }),
  },
  "Post a message to a channel.",
  slackMessagePostSchema,
  async (parsed) => {
    const body: Record<string, unknown> = {
      channel: parsed.channel,
      text: parsed.text,
    };
    putOptionalNonEmptyString(body, "thread_ts", parsed.thread_ts);
    return slackInvokeJson("chat.postMessage", body, "Slack chat.postMessage");
  },
);

const slackMessagePostDmSchema = z.object({
  user_ids: z.string().min(1),
  text: z.string().min(1),
});

reg(
  "slack_message_post_dm",
  "Open or find a DM with user id(s) and send a message (requires HITL slack.message.post).",
  slackMessagePostDmSchema,
  async (parsed) => {
    const token = requireProcessEnv("SLACK_USER_ACCESS_TOKEN");
    const open = await slackApi(token, "conversations.open", {
      users: parsed.user_ids,
      return_im: true,
    });
    if (!open.ok) {
      throw new Error(`Slack conversations.open: ${open.text.slice(0, 400)}`);
    }
    const ch = open.json["channel"];
    const chRec =
      ch !== null && typeof ch === "object" && !Array.isArray(ch)
        ? (ch as SlackApiRecord)
        : undefined;
    const channelId = chRec !== undefined && typeof chRec["id"] === "string" ? chRec["id"] : "";
    if (channelId === "") {
      throw new Error("Slack conversations.open: missing channel id");
    }
    const post = await slackApi(token, "chat.postMessage", {
      channel: channelId,
      text: parsed.text,
    });
    if (!post.ok) {
      throw new Error(`Slack chat.postMessage (dm): ${post.text.slice(0, 400)}`);
    }
    return jsonResult({ open: open.json, post: post.json });
  },
);

// --- ChatOps operational tools (Slice 5) -------------------------------------------------------
// These use the bot/app tokens (xoxb-/xapp-), distinct from the user token the read tools use.
// Only `chatops/reply-dispatcher.ts` + `chatops/transport/` reference `slack_chat_post` (static D17).

const slackUserInfoSchema = z.object({ user: z.string().min(1) });
reg(
  "slack_user_info",
  "Fetch a Slack user's profile (incl. email) by user id (ChatOps identity mapping; bot token).",
  slackUserInfoSchema,
  async (parsed) =>
    slackInvokeJsonWithToken(
      requireProcessEnv("SLACK_BOT_TOKEN"),
      "users.info",
      { user: parsed.user },
      "Slack users.info",
    ),
);

const slackChatPostSchema = z.object({ channel: z.string().min(1), text: z.string().min(1) });
registerWriteTool(
  "slack_chat_post",
  {
    mutates: "slack.chat.post",
    recoverable: true,
    scopeTargetOf: (p) => ({ kind: "channel", value: p.channel }),
  },
  "Post an operational bot message to a channel (ChatOps reply surface; bot token).",
  slackChatPostSchema,
  async (parsed) =>
    slackInvokeJsonWithToken(
      requireProcessEnv("SLACK_BOT_TOKEN"),
      "chat.postMessage",
      { channel: parsed.channel, text: parsed.text },
      "Slack chat.postMessage",
    ),
);

const slackSocketOpenSchema = z.object({});
reg(
  "slack_socket_open",
  "Open a Slack Socket Mode connection and return the short-lived wss:// URL (app-level token).",
  slackSocketOpenSchema,
  async () =>
    slackInvokeJsonWithToken(
      requireProcessEnv("SLACK_APP_TOKEN"), // xapp-… (Socket Mode app-level token)
      "apps.connections.open",
      {},
      "Slack apps.connections.open",
    ),
);

const transport = new StdioServerTransport();
await server.connect(transport);
