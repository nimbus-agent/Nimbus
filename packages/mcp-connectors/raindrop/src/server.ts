import { z } from "zod";
import { matchesResult, searchToolInputSchema } from "../../shared/mcp-search-tool.ts";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { filterRaindropBookmarks } from "./search-filter.ts";

const BASE = "https://api.raindrop.io";

function apiToken(): string {
  const t = process.env["RAINDROP_TOKEN"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("RAINDROP_TOKEN is not set");
  }
  return t;
}

function authHeader(): Record<string, string> {
  return { Authorization: `Bearer ${apiToken()}`, Accept: "application/json" };
}

async function raindropGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Raindrop ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

await runReadOnlyMcpConnector("nimbus-raindrop", (reg) => {
  reg(
    "raindrop_list",
    'List the user\'s Raindrop bookmarks (`GET /rest/v1/raindrops/0?perpage=50` — collection id `0` is the special "all raindrops" collection). Returns the `{ result, items: [...], count }` envelope — `items` holds the bookmark objects.',
    z.object({}),
    async () => {
      return jsonResult(await raindropGet(`/rest/v1/raindrops/0?perpage=50`));
    },
  );

  reg(
    "raindrop_get",
    "Fetch one Raindrop bookmark by its id (`GET /rest/v1/raindrop/{id}` — note the SINGULAR `raindrop` in the get-by-id path). Returns the `{ result, item: {...} }` envelope. Throws when no match is found.",
    z.object({
      id: z.string().min(1),
    }),
    async (p) => {
      return jsonResult(await raindropGet(`/rest/v1/raindrop/${encodeURIComponent(p.id)}`));
    },
  );

  reg(
    "raindrop_search",
    "Substring search across the user's Raindrop bookmarks (first page only). Matches the query against the bookmark title, excerpt, note, domain, link, type, and tags (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    searchToolInputSchema(100),
    async (p) => {
      const root = await raindropGet(`/rest/v1/raindrops/0?perpage=50`);
      const items = (root as { items?: unknown[] } | null)?.items;
      return matchesResult(items, filterRaindropBookmarks, p);
    },
  );
});
