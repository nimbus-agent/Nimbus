import { z } from "zod";
import { matchesResult } from "../../shared/mcp-search-tool.ts";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { filterCodemagicBuilds } from "./search-filter.ts";

const CODEMAGIC_API = "https://api.codemagic.io";

function authHeader(): Record<string, string> {
  const t = process.env["CODEMAGIC_TOKEN"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("CODEMAGIC_TOKEN is not set");
  }
  return { "x-auth-token": t, Accept: "application/json" };
}

async function codemagicGet(path: string): Promise<unknown> {
  const res = await fetch(`${CODEMAGIC_API}${path}`, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Codemagic ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

await runReadOnlyMcpConnector("nimbus-codemagic", (reg) => {
  reg(
    "codemagic_list",
    "List Codemagic resources. When `appId` is omitted, returns the user's accessible apps via `/apps`. When `appId` is provided, returns the app's recent builds via `/builds?appId=<id>` (limit optional).",
    z.object({
      appId: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    async (p) => {
      if (p.appId === undefined) {
        return jsonResult(await codemagicGet("/apps"));
      }
      const limit = p.limit ?? 50;
      return jsonResult(
        await codemagicGet(`/builds?appId=${encodeURIComponent(p.appId)}&limit=${String(limit)}`),
      );
    },
  );

  reg(
    "codemagic_get",
    "Fetch a single Codemagic resource. When `buildId` is provided, returns the build via `/builds/<buildId>`. When omitted, returns the app via `/apps` filtered to `appId`.",
    z.object({
      appId: z.string().min(1),
      buildId: z.string().min(1).optional(),
    }),
    async (p) => {
      if (p.buildId === undefined) {
        return jsonResult(await codemagicGet("/apps"));
      }
      return jsonResult(await codemagicGet(`/builds/${encodeURIComponent(p.buildId)}`));
    },
  );

  reg(
    "codemagic_search",
    "Substring search across a Codemagic app's recent builds. Matches the query against `branch`, `message`, `workflowId`, and `status` (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    z.object({
      appId: z.string().min(1),
      query: z.string().min(1),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    async (p) => {
      const root = await codemagicGet(`/builds?appId=${encodeURIComponent(p.appId)}&limit=50`);
      const builds = (root as { builds?: unknown[] } | null)?.builds;
      return matchesResult(builds, filterCodemagicBuilds, p);
    },
  );
});
