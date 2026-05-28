import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
} from "../../shared/mcp-tool-kit.ts";
import { filterStackOverflowQuestions } from "./search-filter.ts";

const BASE = "https://api.stackoverflowteams.com";

function apiToken(): string {
  const t = process.env["STACKOVERFLOW_TOKEN"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("STACKOVERFLOW_TOKEN is not set");
  }
  return t;
}

function teamSlug(): string {
  const t = process.env["STACKOVERFLOW_TEAM"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("STACKOVERFLOW_TEAM is not set");
  }
  return t;
}

function authHeader(): Record<string, string> {
  return { Authorization: `Bearer ${apiToken()}`, Accept: "application/json" };
}

async function stackOverflowGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Stack Overflow ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

function questionsBasePath(): string {
  return `/v3/teams/${encodeURIComponent(teamSlug())}/questions`;
}

const mcp = new McpServer({ name: "nimbus-stackoverflow", version: "0.1.0" });
const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));

reg(
  "stackoverflow_list",
  "List the team's Stack Overflow for Teams questions (`GET /v3/teams/<team>/questions?page=1&pagesize=100&sort=creation&order=desc`). Returns the `{ items: [...], totalCount, pageSize, page, totalPages, sort, order }` envelope — `items` holds the question objects.",
  z.object({}),
  async () => {
    return jsonResult(
      await stackOverflowGet(`${questionsBasePath()}?page=1&pagesize=100&sort=creation&order=desc`),
    );
  },
);

reg(
  "stackoverflow_get",
  "Fetch one Stack Overflow for Teams question by its id (`GET /v3/teams/<team>/questions/{id}`). Returns the question object directly (NOT wrapped in an `{ items }` envelope). Throws when no match is found.",
  z.object({
    id: z.string().min(1),
  }),
  async (p) => {
    return jsonResult(await stackOverflowGet(`${questionsBasePath()}/${encodeURIComponent(p.id)}`));
  },
);

reg(
  "stackoverflow_search",
  "Substring search across the team's Stack Overflow for Teams questions (first page only). Matches the query against the question title, body, tags, and the asking user's name (case-insensitive). Returns a `{ matches: [...] }` envelope.",
  z.object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  async (p) => {
    const root = await stackOverflowGet(
      `${questionsBasePath()}?page=1&pagesize=100&sort=creation&order=desc`,
    );
    const items = (root as { items?: unknown[] } | null)?.items;
    const matches = Array.isArray(items)
      ? filterStackOverflowQuestions(items, { query: p.query, limit: p.limit })
      : [];
    return jsonResult({ matches });
  },
);

const transport = new StdioServerTransport();
await mcp.connect(transport);
