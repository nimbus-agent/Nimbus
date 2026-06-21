import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { createRegisterSimpleTool, createZodToolRegistrar } from "../../shared/mcp-tool-kit.ts";
import { makeRestToolRegistrar } from "../../shared/rest-tool-kit.ts";

const DISCORD_API = "https://discord.com/api/v10";

async function discordFetch(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<{
  ok: boolean;
  status: number;
  json: unknown;
  text: string;
}> {
  const url = path.startsWith("http") ? path : `${DISCORD_API}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bot ${token}`,
      "User-Agent": "NimbusMCP (https://github.com/nimbus-dev/nimbus)",
      ...(init?.headers as Record<string, string> | undefined),
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

/** Standard Discord read tool: token → discordFetch(buildPath) → mcpJsonResultIfOk("Discord"). */
const registerDiscordTool = makeRestToolRegistrar({
  registrar: reg,
  tokenEnv: "DISCORD_BOT_TOKEN",
  serviceLabel: "Discord",
  fetch: discordFetch,
});

registerDiscordTool(
  "discord_guild_list",
  "List guilds the bot is a member of.",
  z.object({}),
  () => "/users/@me/guilds",
);

registerDiscordTool(
  "discord_channel_list",
  "List channels in a guild (id, type, name).",
  z.object({ guildId: z.string().min(1) }),
  (parsed) => `/guilds/${encodeURIComponent(parsed.guildId)}/channels`,
);

registerDiscordTool(
  "discord_channel_messages",
  "List recent messages in a channel (newest first). Optional `after` snowflake for incremental fetch.",
  z.object({
    channelId: z.string().min(1),
    limit: z.number().int().min(1).max(100).optional(),
    after: z.string().optional(),
  }),
  (parsed) => {
    const lim = parsed.limit ?? 50;
    const u = new URL(`${DISCORD_API}/channels/${encodeURIComponent(parsed.channelId)}/messages`);
    u.searchParams.set("limit", String(lim));
    if (parsed.after !== undefined && parsed.after !== "") {
      u.searchParams.set("after", parsed.after);
    }
    return `${u.pathname}${u.search}`;
  },
);

registerDiscordTool(
  "discord_thread_list",
  "List active threads in a guild (includes public threads the bot can see).",
  z.object({ guildId: z.string().min(1) }),
  (parsed) => `/guilds/${encodeURIComponent(parsed.guildId)}/threads/active`,
);

const transport = new StdioServerTransport();
await server.connect(transport);
