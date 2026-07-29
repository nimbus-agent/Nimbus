import { z } from "zod";
import { matchesResult, searchToolInputSchema } from "../../shared/mcp-search-tool.ts";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { filterRaindropBookmarks, filterRaindropCollections } from "./search-filter.ts";

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

/**
 * Raindrop splits collections across two unpaginated endpoints — `/collections`
 * (root) and `/collections/childrens` (every nested one). "List my collections"
 * means both, so drain both and concatenate the `items` arrays.
 */
async function allCollections(): Promise<unknown[]> {
  const [root, children] = await Promise.all([
    raindropGet(`/rest/v1/collections`),
    raindropGet(`/rest/v1/collections/childrens`),
  ]);
  const itemsOf = (envelope: unknown): unknown[] => {
    const items = (envelope as { items?: unknown } | null)?.items;
    return Array.isArray(items) ? items : [];
  };
  return [...itemsOf(root), ...itemsOf(children)];
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

  reg(
    "raindrop_collections_list",
    "List ALL the user's Raindrop collections — the records a bookmark's `collectionId` points at. Raindrop splits them across two unpaginated endpoints, so this drains BOTH (`GET /rest/v1/collections` for root collections and `GET /rest/v1/collections/childrens` for every nested one) and returns their concatenated `items` as `{ items: [...] }`. A nested collection carries `parent.$id`; a root one does not. Note that collection id `0` — the special \"all raindrops\" collection the bookmark list reads — is NOT returned by either endpoint.",
    z.object({}),
    async () => {
      return jsonResult({ items: await allCollections() });
    },
  );

  reg(
    "raindrop_collection_get",
    "Fetch one Raindrop collection by its id (`GET /rest/v1/collection/{id}` — note the SINGULAR `collection` in the get-by-id path). The collection id space is SEPARATE from the bookmark id space: pass a bookmark's `collectionId`, not its `_id`. Returns the `{ result, item: {...} }` envelope. Throws when no match is found.",
    z.object({
      id: z.string().min(1),
    }),
    async (p) => {
      return jsonResult(await raindropGet(`/rest/v1/collection/${encodeURIComponent(p.id)}`));
    },
  );

  reg(
    "raindrop_collections_search",
    "Substring search across ALL the user's Raindrop collections (root + nested). Matches the query against the collection title, view, and color (case-insensitive) — the Raindrop Collection object has no description field. Returns a `{ matches: [...] }` envelope.",
    searchToolInputSchema(100),
    async (p) => {
      return matchesResult(await allCollections(), filterRaindropCollections, p);
    },
  );
});
