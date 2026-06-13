import { z } from "zod";
import { fetchWithTimeout, mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { filterBigeyeIssues } from "./search-filter.ts";

function apiBase(): string {
  const v = process.env["BIGEYE_BASE_URL"]?.trim();
  if (v === undefined || v === "") {
    throw new Error("BIGEYE_BASE_URL is not set");
  }
  return v.endsWith("/") ? v.slice(0, -1) : v;
}

function authHeader(): Record<string, string> {
  const k = process.env["BIGEYE_API_KEY"]?.trim();
  if (k === undefined || k === "") {
    throw new Error("BIGEYE_API_KEY is not set");
  }
  return { Authorization: `Bearer ${k}`, Accept: "application/json" };
}

async function fetchIssues(): Promise<unknown[]> {
  const res = await fetchWithTimeout(`${apiBase()}/api/v1/issues`, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Bigeye ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  const parsed = JSON.parse(text) as unknown;
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (parsed !== null && typeof parsed === "object") {
    const root = parsed as Record<string, unknown>;
    if (Array.isArray(root["issues"])) return root["issues"];
    if (Array.isArray(root["data"])) return root["data"];
  }
  return [];
}

function issueId(item: unknown): string {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return "";
  const row = item as Record<string, unknown>;
  const v = row["id"];
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return "";
}

await runReadOnlyMcpConnector("nimbus-bigeye", (reg) => {
  reg(
    "bigeye_list",
    "List Bigeye data-quality issues. `limit` (default 200, max 500) caps the returned list.",
    z.object({
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async (p) => {
      const issues = await fetchIssues();
      const cap = p.limit ?? 200;
      return jsonResult({ items: issues.slice(0, cap) });
    },
  );

  reg(
    "bigeye_get",
    "Fetch one Bigeye data-quality issue by its id. Throws when the issue is not found.",
    z.object({
      id: z.string().min(1),
    }),
    async (p) => {
      const issues = await fetchIssues();
      const found = issues.find((item) => issueId(item) === p.id);
      if (found === undefined) {
        throw new Error(`Bigeye issue not found: ${p.id}`);
      }
      return jsonResult(found);
    },
  );

  reg(
    "bigeye_search",
    "Substring search across Bigeye data-quality issues. Matches the query (case-insensitive) against issue summary, title, and description. Returns a `{ matches: [...] }` envelope.",
    z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    async (p) => {
      const issues = await fetchIssues();
      const matches = filterBigeyeIssues(issues, { query: p.query, limit: p.limit });
      return jsonResult({ matches });
    },
  );
});
