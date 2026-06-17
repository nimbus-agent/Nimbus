import { z } from "zod";
import { matchesResult, searchToolInputSchema } from "../../shared/mcp-search-tool.ts";
import { encodeBasicAuthHeader, mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { filterZendeskTickets } from "./search-filter.ts";

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function baseUrl(): string {
  const v = process.env["ZENDESK_URL"]?.trim();
  if (v === undefined || v === "") {
    throw new Error("ZENDESK_URL is not set");
  }
  return trimTrailingSlash(v);
}

function authHeader(): Record<string, string> {
  const email = process.env["ZENDESK_EMAIL"]?.trim();
  if (email === undefined || email === "") {
    throw new Error("ZENDESK_EMAIL is not set");
  }
  const token = process.env["ZENDESK_API_TOKEN"]?.trim();
  if (token === undefined || token === "") {
    throw new Error("ZENDESK_API_TOKEN is not set");
  }
  return {
    Authorization: encodeBasicAuthHeader(`${email}/token`, token),
    Accept: "application/json",
  };
}

async function zendeskGet(path: string): Promise<unknown> {
  const res = await fetch(`${baseUrl()}${path}`, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Zendesk ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

await runReadOnlyMcpConnector("nimbus-zendesk", (reg) => {
  reg(
    "zendesk_list",
    "List the user's Zendesk tickets (`GET /api/v2/tickets.json?page[size]=100`). Returns the cursor-pagination envelope `{ tickets: [...], meta: { has_more, after_cursor }, links: { next } }` — `tickets` holds the ticket objects.",
    z.object({}),
    async () => {
      return jsonResult(await zendeskGet(`/api/v2/tickets.json?page[size]=100`));
    },
  );

  reg(
    "zendesk_get",
    "Fetch one Zendesk ticket by its numeric id (`GET /api/v2/tickets/{id}.json`). Returns the `{ ticket: {...} }` envelope. Throws when no match is found.",
    z.object({
      id: z.string().min(1),
    }),
    async (p) => {
      return jsonResult(await zendeskGet(`/api/v2/tickets/${encodeURIComponent(p.id)}.json`));
    },
  );

  reg(
    "zendesk_search",
    "Substring search across the user's Zendesk tickets (first page only). Matches the query against the ticket subject, description, status, priority, type, and tags (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    searchToolInputSchema(100),
    async (p) => {
      const root = await zendeskGet(`/api/v2/tickets.json?page[size]=100`);
      const tickets = (root as { tickets?: unknown[] } | null)?.tickets;
      return matchesResult(tickets, filterZendeskTickets, p);
    },
  );
});
