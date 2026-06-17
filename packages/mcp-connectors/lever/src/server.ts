import { z } from "zod";
import { matchesResult, searchToolInputSchema } from "../../shared/mcp-search-tool.ts";
import { encodeBasicAuthHeader, mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { filterLeverPostings } from "./search-filter.ts";

const BASE = "https://api.lever.co";

function apiKey(): string {
  const t = process.env["LEVER_API_KEY"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("LEVER_API_KEY is not set");
  }
  return t;
}

function authHeader(): Record<string, string> {
  return { Authorization: encodeBasicAuthHeader(apiKey(), ""), Accept: "application/json" };
}

async function leverGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Lever ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

await runReadOnlyMcpConnector("nimbus-lever", (reg) => {
  reg(
    "lever_list",
    "List the company's published Lever job postings (`GET /v1/postings?limit=100`). Returns the offset-cursor envelope `{ data: [...], hasNext: boolean, next?: string }` — `data` holds the posting objects.",
    z.object({}),
    async () => {
      return jsonResult(await leverGet(`/v1/postings?limit=100`));
    },
  );

  reg(
    "lever_get",
    "Fetch one Lever job posting by its id (`GET /v1/postings/{id}`). Returns the `{ data: {...} }` envelope. Throws when no match is found.",
    z.object({
      id: z.string().min(1),
    }),
    async (p) => {
      return jsonResult(await leverGet(`/v1/postings/${encodeURIComponent(p.id)}`));
    },
  );

  reg(
    "lever_search",
    "Substring search across the company's Lever job postings (first page only). Matches the query against the posting text (title), state, and the team/department/location categories and tags (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    searchToolInputSchema(100),
    async (p) => {
      const root = await leverGet(`/v1/postings?limit=100`);
      const data = (root as { data?: unknown[] } | null)?.data;
      return matchesResult(data, filterLeverPostings, p);
    },
  );
});
