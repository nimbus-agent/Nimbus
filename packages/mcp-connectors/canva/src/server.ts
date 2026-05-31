import { z } from "zod";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { filterCanvaDesigns } from "./search-filter.ts";

const BASE = "https://api.canva.com";

function apiToken(): string {
  const t = process.env["CANVA_TOKEN"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("CANVA_TOKEN is not set");
  }
  return t;
}

function authHeader(): Record<string, string> {
  return { Authorization: `Bearer ${apiToken()}`, Accept: "application/json" };
}

async function canvaGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Canva ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

function designsFrom(root: unknown): unknown[] {
  const items = (root as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? items : [];
}

await runReadOnlyMcpConnector("nimbus-canva", (reg) => {
  reg(
    "canva_list",
    "List the authenticated user's Canva designs (GET /rest/v1/designs?continuation=<token>). Returns the { items: [...], continuation? } envelope — `items` holds the design objects, each shaped { id, title, created_at, updated_at, urls: { edit_url, view_url }, thumbnail: { url, width, height }, ... }; `continuation` (when present) is the opaque token for the next page.",
    z.object({
      continuation: z.string().optional(),
    }),
    async (p) => {
      const params = new URLSearchParams();
      if (p.continuation !== undefined && p.continuation !== "") {
        params.set("continuation", p.continuation);
      }
      const qs = params.toString();
      return jsonResult(await canvaGet(`/rest/v1/designs${qs === "" ? "" : `?${qs}`}`));
    },
  );

  reg(
    "canva_get",
    "Fetch one Canva design by its id (GET /rest/v1/designs/{designId}). Returns the { design: { id, title, created_at, updated_at, urls, thumbnail, ... } } envelope. Throws when no design with that id exists.",
    z.object({
      id: z.string().min(1),
    }),
    async (p) => {
      return jsonResult(await canvaGet(`/rest/v1/designs/${encodeURIComponent(p.id)}`));
    },
  );

  reg(
    "canva_search",
    "**Substring search over the FIRST PAGE only** of the authenticated user's Canva designs. This tool fetches GET /rest/v1/designs once and matches the query locally (case-insensitive) against the design title. **Designs beyond the first page are not searchable here — query the local Nimbus index instead for full coverage.** Returns a { matches: [...] } envelope.",
    z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    async (p) => {
      const root = await canvaGet("/rest/v1/designs");
      const matches = filterCanvaDesigns(designsFrom(root), {
        query: p.query,
        limit: p.limit,
      });
      return jsonResult({ matches });
    },
  );
});
