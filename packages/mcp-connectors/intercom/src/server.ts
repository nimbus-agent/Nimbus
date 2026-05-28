import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
} from "../../shared/mcp-tool-kit.ts";
import { filterIntercomConversations } from "./search-filter.ts";

const BASE = "https://api.intercom.io";

function apiToken(): string {
  const t = process.env["INTERCOM_TOKEN"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("INTERCOM_TOKEN is not set");
  }
  return t;
}

function authHeader(): Record<string, string> {
  return {
    Authorization: `Bearer ${apiToken()}`,
    "Intercom-Version": "2.11",
    Accept: "application/json",
  };
}

async function intercomGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Intercom ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

const mcp = new McpServer({ name: "nimbus-intercom", version: "0.1.0" });
const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));

reg(
  "intercom_list",
  'List the user\'s Intercom conversations (`GET /conversations?per_page=150`). Returns the `{ type: "conversation.list", conversations: [...], pages, total_count }` envelope — `conversations` holds the conversation objects.',
  z.object({}),
  async () => {
    return jsonResult(await intercomGet(`/conversations?per_page=150`));
  },
);

reg(
  "intercom_get",
  "Fetch one Intercom conversation by its id (`GET /conversations/{id}` — note the PLURAL `conversations` in the get-by-id path). Returns the conversation object directly. Throws when no match is found.",
  z.object({
    id: z.string().min(1),
  }),
  async (p) => {
    return jsonResult(await intercomGet(`/conversations/${encodeURIComponent(p.id)}`));
  },
);

reg(
  "intercom_search",
  "Substring search across the user's Intercom conversations (first page only). Matches the query against the conversation subject, the source message body, the state, the source author name + email, and the tags (case-insensitive). Returns a `{ matches: [...] }` envelope.",
  z.object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  async (p) => {
    const root = await intercomGet(`/conversations?per_page=150`);
    const conversations = (root as { conversations?: unknown[] } | null)?.conversations;
    const matches = Array.isArray(conversations)
      ? filterIntercomConversations(conversations, { query: p.query, limit: p.limit })
      : [];
    return jsonResult({ matches });
  },
);

const transport = new StdioServerTransport();
await mcp.connect(transport);
