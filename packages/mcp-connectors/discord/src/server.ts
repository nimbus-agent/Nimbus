import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResultIfOk,
  requireProcessEnv,
} from "../../shared/mcp-tool-kit.ts";

const DISCORD_API = "https://discord.com/api/v10";

async function discordFetch(path: string): Promise<{
  ok: boolean;
  status: number;
  json: unknown;
  text: string;
}> {
  const token = requireProcessEnv("DISCORD_BOT_TOKEN");
  const url = path.startsWith("http") ? path : `${DISCORD_API}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bot ${token}`,
      "User-Agent": "NimbusMCP (https://github.com/nimbus-dev/nimbus)",
    },
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, text };
}

const server = new McpServer({ name: "nimbus-discord", version: "0.1.0" });

const registerSimpleTool = createRegisterSimpleTool(server);
const reg = createZodToolRegistrar(registerSimpleTool);

reg("discord_guild_list", "List guilds the bot is a member of.", z.object({}), async () => {
  const res = await discordFetch("/users/@me/guilds");
  return mcpJsonResultIfOk("Discord", res);
});

reg(
  "discord_channel_list",
  "List channels in a guild (id, type, name).",
  z.object({ guildId: z.string().min(1) }),
  async (parsed) => {
    const res = await discordFetch(`/guilds/${encodeURIComponent(parsed.guildId)}/channels`);
    return mcpJsonResultIfOk("Discord", res);
  },
);

reg(
  "discord_channel_messages",
  "List recent messages in a channel (newest first). Optional `after` snowflake for incremental fetch.",
  z.object({
    channelId: z.string().min(1),
    limit: z.number().int().min(1).max(100).optional(),
    after: z.string().optional(),
  }),
  async (parsed) => {
    const lim = parsed.limit ?? 50;
    const u = new URL(`${DISCORD_API}/channels/${encodeURIComponent(parsed.channelId)}/messages`);
    u.searchParams.set("limit", String(lim));
    if (parsed.after !== undefined && parsed.after !== "") {
      u.searchParams.set("after", parsed.after);
    }
    const res = await discordFetch(`${u.pathname}${u.search}`);
    return mcpJsonResultIfOk("Discord", res);
  },
);

reg(
  "discord_thread_list",
  "List active threads in a guild (includes public threads the bot can see).",
  z.object({ guildId: z.string().min(1) }),
  async (parsed) => {
    const res = await discordFetch(`/guilds/${encodeURIComponent(parsed.guildId)}/threads/active`);
    return mcpJsonResultIfOk("Discord", res);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
