import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
} from "../../shared/mcp-tool-kit.ts";
import { filterReadwiseHighlights } from "./search-filter.ts";

const BASE = "https://readwise.io";

function apiToken(): string {
  const t = process.env["READWISE_TOKEN"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("READWISE_TOKEN is not set");
  }
  return t;
}

function authHeader(): Record<string, string> {
  return { Authorization: `Token ${apiToken()}`, Accept: "application/json" };
}

async function readwiseGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Readwise ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

const mcp = new McpServer({ name: "nimbus-readwise", version: "0.1.0" });
const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));

reg(
  "readwise_list",
  "List the user's Readwise highlights (`GET /api/v2/highlights/?page_size=1000`). Returns the DRF `{ count, next, previous, results: [...] }` envelope — `results` holds the highlight objects and `next` is the next-page URL (null on the last page).",
  z.object({}),
  async () => {
    return jsonResult(await readwiseGet(`/api/v2/highlights/?page_size=1000`));
  },
);

reg(
  "readwise_get",
  "Fetch one Readwise highlight by its id (`GET /api/v2/highlights/{id}/`). Returns the highlight object directly. Throws when no match is found.",
  z.object({
    id: z.string().min(1),
  }),
  async (p) => {
    return jsonResult(await readwiseGet(`/api/v2/highlights/${encodeURIComponent(p.id)}/`));
  },
);

reg(
  "readwise_search",
  "Substring search across the user's Readwise highlights (first page only). Matches the query against the highlight text, the user's note, color, location_type, and tag names (case-insensitive). Returns a `{ matches: [...] }` envelope.",
  z.object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  async (p) => {
    const root = await readwiseGet(`/api/v2/highlights/?page_size=1000`);
    const results = (root as { results?: unknown[] } | null)?.results;
    const matches = Array.isArray(results)
      ? filterReadwiseHighlights(results, { query: p.query, limit: p.limit })
      : [];
    return jsonResult({ matches });
  },
);

const transport = new StdioServerTransport();
await mcp.connect(transport);
