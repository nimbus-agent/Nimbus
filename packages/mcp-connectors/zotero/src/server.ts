import { z } from "zod";
import { matchesResult, searchToolInputSchema } from "../../shared/mcp-search-tool.ts";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { filterZoteroItems } from "./search-filter.ts";

const BASE = "https://api.zotero.org";

function apiKey(): string {
  const k = process.env["ZOTERO_API_KEY"]?.trim();
  if (k === undefined || k === "") {
    throw new Error("ZOTERO_API_KEY is not set");
  }
  return k;
}

function library(): string {
  const l = process.env["ZOTERO_LIBRARY"]?.trim();
  if (l === undefined || l === "") {
    throw new Error("ZOTERO_LIBRARY is not set");
  }
  return l;
}

function authHeader(): Record<string, string> {
  return {
    "Zotero-API-Key": apiKey(),
    "Zotero-API-Version": "3",
    Accept: "application/json",
  };
}

async function zoteroGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Zotero ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

function itemsBasePath(): string {
  return `/${library()}/items`;
}

await runReadOnlyMcpConnector("nimbus-zotero", (reg) => {
  reg(
    "zotero_list",
    "List the top-level items in the configured Zotero library (`GET /<library>/items?format=json&limit=100&start=0&sort=dateModified&direction=desc`). The `<library>` path segment is the configured library spec (e.g. `users/12345` or `groups/98765`). Returns the raw JSON array of item objects — each is `{ key, version, library, data: { itemType, title, creators, date, dateModified, tags, collections, DOI, url, abstractNote, ... } }`.",
    z.object({}),
    async () => {
      return jsonResult(
        await zoteroGet(
          `${itemsBasePath()}?format=json&limit=100&start=0&sort=dateModified&direction=desc`,
        ),
      );
    },
  );

  reg(
    "zotero_get",
    "Fetch one Zotero item by its item key (`GET /<library>/items/{key}`). Returns the item object directly (NOT wrapped in an array). Throws when no match is found.",
    z.object({
      key: z.string().min(1),
    }),
    async (p) => {
      return jsonResult(await zoteroGet(`${itemsBasePath()}/${encodeURIComponent(p.key)}`));
    },
  );

  reg(
    "zotero_search",
    "Substring search across the library's top-level items (first page only). Matches the query against the title, item type, abstract, DOI, publication title, formatted creator names, and tag names (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    searchToolInputSchema(100),
    async (p) => {
      const root = await zoteroGet(
        `${itemsBasePath()}?format=json&limit=100&start=0&sort=dateModified&direction=desc`,
      );
      return matchesResult(root, filterZoteroItems, p);
    },
  );
});
