import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { fetchBearerAuthorizedJson, resolveUrlWithBase } from "../../shared/fetch-bearer-json.ts";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  type McpListResult,
  mcpJsonResultIfOk,
  requireProcessEnv,
} from "../../shared/mcp-tool-kit.ts";
import { teamsBotSendActivity } from "./bot-send.ts";

const GRAPH = "https://graph.microsoft.com/v1.0";

async function graphRequest(
  token: string,
  pathOrUrl: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const url = resolveUrlWithBase(GRAPH, pathOrUrl);
  return fetchBearerAuthorizedJson(url, token, init);
}

async function teamsPagedGraph(
  token: string,
  nextLink: string | undefined,
  initialPath: string,
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const path = nextLink !== undefined && nextLink !== "" ? nextLink : initialPath;
  return graphRequest(token, path);
}

function graphListResult(r: {
  ok: boolean;
  status: number;
  json: unknown;
  text: string;
}): McpListResult {
  return mcpJsonResultIfOk("Graph", r, 200);
}

const server = new McpServer({ name: "nimbus-teams", version: "0.1.0" });

const registerSimpleTool = createRegisterSimpleTool(server);

import { createWriteToolRegistrar } from "../../shared/consent-kit.ts";

const reg = createZodToolRegistrar(registerSimpleTool);

/**
 * Every MUTATING teams tool goes through here. Outside the gateway this adds the
 * consent gate, the write-scope allow-list, the mutation budget and the audit record; inside
 * the gateway it is a pass-through, because executor.ts (I2) is the gate there.
 */
const registerWriteTool = createWriteToolRegistrar(server, {
  connector: "teams",
  scopeEnv: "NIMBUS_MCP_TEAMS_WRITE_SCOPE",
  scopeKinds: ["channel", "chat"],
});

const teamsTeamListSchema = z.object({
  top: z.number().int().min(1).max(100).optional(),
  nextLink: z.url().optional(),
});

reg(
  "teams_team_list",
  "List Microsoft Teams the signed-in user has joined (pagination via nextLink).",
  teamsTeamListSchema,
  async (parsed) => {
    const token = requireProcessEnv("MICROSOFT_OAUTH_ACCESS_TOKEN");
    const initial = `/me/joinedTeams?$top=${String(parsed.top ?? 50)}`;
    const r = await teamsPagedGraph(token, parsed.nextLink, initial);
    return graphListResult(r);
  },
);

const teamsChannelListSchema = z.object({
  teamId: z.string().min(1),
  top: z.number().int().min(1).max(100).optional(),
  nextLink: z.url().optional(),
});

reg(
  "teams_channel_list",
  "List channels in a team (standard + private the app can read).",
  teamsChannelListSchema,
  async (parsed) => {
    const token = requireProcessEnv("MICROSOFT_OAUTH_ACCESS_TOKEN");
    const tid = encodeURIComponent(parsed.teamId);
    const initial = `/teams/${tid}/channels?$top=${String(parsed.top ?? 50)}`;
    const r = await teamsPagedGraph(token, parsed.nextLink, initial);
    return graphListResult(r);
  },
);

const teamsChannelMessagesSchema = z.object({
  teamId: z.string().min(1),
  channelId: z.string().min(1),
  top: z.number().int().min(1).max(50).optional(),
  nextLink: z.url().optional(),
});

reg(
  "teams_channel_messages",
  "List recent messages in a team channel (not delta; for interactive reads).",
  teamsChannelMessagesSchema,
  async (parsed) => {
    const token = requireProcessEnv("MICROSOFT_OAUTH_ACCESS_TOKEN");
    const tid = encodeURIComponent(parsed.teamId);
    const cid = encodeURIComponent(parsed.channelId);
    const initial = `/teams/${tid}/channels/${cid}/messages?$top=${String(parsed.top ?? 25)}`;
    const r = await teamsPagedGraph(token, parsed.nextLink, initial);
    return graphListResult(r);
  },
);

const teamsChatListSchema = z.object({
  top: z.number().int().min(1).max(50).optional(),
  nextLink: z.url().optional(),
});

reg(
  "teams_chat_list",
  "List 1:1 and group chats for the signed-in user.",
  teamsChatListSchema,
  async (parsed) => {
    const token = requireProcessEnv("MICROSOFT_OAUTH_ACCESS_TOKEN");
    const initial = `/me/chats?$top=${String(parsed.top ?? 25)}`;
    const r = await teamsPagedGraph(token, parsed.nextLink, initial);
    return graphListResult(r);
  },
);

const teamsChatMessagesSchema = z.object({
  chatId: z.string().min(1),
  top: z.number().int().min(1).max(50).optional(),
  nextLink: z.url().optional(),
});

reg("teams_chat_messages", "List messages in a chat.", teamsChatMessagesSchema, async (parsed) => {
  const token = requireProcessEnv("MICROSOFT_OAUTH_ACCESS_TOKEN");
  const id = encodeURIComponent(parsed.chatId);
  const initial = `/chats/${id}/messages?$top=${String(parsed.top ?? 25)}`;
  const r = await teamsPagedGraph(token, parsed.nextLink, initial);
  return graphListResult(r);
});

const teamsMessagePostSchema = z.object({
  teamId: z.string().min(1),
  channelId: z.string().min(1),
  body: z.string().min(1),
  contentType: z.enum(["text", "html"]).optional(),
});

registerWriteTool(
  "teams_message_post",
  {
    mutates: "teams.message.post",
    recoverable: true,
    scopeTargetOf: (p) => ({ kind: "channel", value: `${p.teamId}/${p.channelId}` }),
  },
  "Post a message to a team channel.",
  teamsMessagePostSchema,
  async (parsed) => {
    const token = requireProcessEnv("MICROSOFT_OAUTH_ACCESS_TOKEN");
    const tid = encodeURIComponent(parsed.teamId);
    const cid = encodeURIComponent(parsed.channelId);
    const ct = parsed.contentType ?? "text";
    const r = await graphRequest(token, `/teams/${tid}/channels/${cid}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body: {
          contentType: ct === "html" ? "html" : "text",
          content: parsed.body,
        },
      }),
    });
    return graphListResult(r);
  },
);

const teamsMessagePostChatSchema = z.object({
  chatId: z.string().min(1),
  body: z.string().min(1),
  contentType: z.enum(["text", "html"]).optional(),
});

reg(
  "teams_message_post_chat",
  "Post a message to a chat (requires HITL teams.message.postChat).",
  teamsMessagePostChatSchema,
  async (parsed) => {
    const token = requireProcessEnv("MICROSOFT_OAUTH_ACCESS_TOKEN");
    const id = encodeURIComponent(parsed.chatId);
    const ct = parsed.contentType ?? "text";
    const r = await graphRequest(token, `/chats/${id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body: {
          contentType: ct === "html" ? "html" : "text",
          content: parsed.body,
        },
      }),
    });
    return graphListResult(r);
  },
);

// --- ChatOps operational tools (Slice 5) -------------------------------------------------------
// `teams_chat_post` uses bot app credentials (Bot Framework), distinct from the user Graph token.
// Only `chatops/reply-dispatcher.ts` + `chatops/transport/` reference `teams_chat_post` (static D17).

const teamsUserInfoSchema = z.object({ userId: z.string().min(1) });
reg(
  "teams_user_info",
  "Fetch a Teams/AAD user (incl. mail/userPrincipalName) by id (ChatOps identity mapping).",
  teamsUserInfoSchema,
  async (parsed) => {
    const token = requireProcessEnv("MICROSOFT_OAUTH_ACCESS_TOKEN");
    const r = await teamsPagedGraph(
      token,
      undefined,
      `/users/${encodeURIComponent(parsed.userId)}`,
    );
    return graphListResult(r);
  },
);

const teamsChatPostSchema = z.object({
  conversationId: z.string().min(1),
  text: z.string().min(1),
});
registerWriteTool(
  "teams_chat_post",
  {
    mutates: "teams.chat.post",
    recoverable: true,
    scopeTargetOf: (p) => ({ kind: "chat", value: p.conversationId }),
  },
  "Post an operational bot message to a Teams conversation (ChatOps reply surface; bot app creds).",
  teamsChatPostSchema,
  async (parsed) => {
    const r = await teamsBotSendActivity(parsed.conversationId, parsed.text);
    return graphListResult(r);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
