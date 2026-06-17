import { z } from "zod";
import { matchesResult } from "../../shared/mcp-search-tool.ts";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { filterBitriseBuilds } from "./search-filter.ts";

const BITRISE_API = "https://api.bitrise.io";

function authHeader(): Record<string, string> {
  const t = process.env["BITRISE_TOKEN"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("BITRISE_TOKEN is not set");
  }
  return { Authorization: t, Accept: "application/json" };
}

async function bitriseGet(path: string): Promise<unknown> {
  const res = await fetch(`${BITRISE_API}${path}`, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Bitrise ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

await runReadOnlyMcpConnector("nimbus-bitrise", (reg) => {
  reg(
    "bitrise_list",
    "List Bitrise resources. When `appSlug` is omitted, returns the user's accessible apps via `/v0.1/me/apps`. When `appSlug` is provided, returns the app's recent builds via `/v0.1/apps/<slug>/builds` (status filter and limit optional).",
    z.object({
      appSlug: z.string().min(1).optional(),
      status: z.enum(["not-finished", "successful", "failed", "aborted"]).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    async (p) => {
      if (p.appSlug === undefined) {
        const limit = p.limit ?? 50;
        return jsonResult(await bitriseGet(`/v0.1/me/apps?limit=${String(limit)}`));
      }
      const params: string[] = [];
      params.push(`limit=${String(p.limit ?? 50)}`);
      if (p.status !== undefined) {
        const map = { "not-finished": 0, successful: 1, failed: 2, aborted: 3 } as const;
        params.push(`status=${String(map[p.status])}`);
      }
      const qs = `?${params.join("&")}`;
      return jsonResult(
        await bitriseGet(`/v0.1/apps/${encodeURIComponent(p.appSlug)}/builds${qs}`),
      );
    },
  );

  reg(
    "bitrise_get",
    "Fetch a single Bitrise resource. When `buildSlug` is provided, returns the build via `/v0.1/apps/<appSlug>/builds/<buildSlug>`. When omitted, returns the app via `/v0.1/apps/<appSlug>`.",
    z.object({
      appSlug: z.string().min(1),
      buildSlug: z.string().min(1).optional(),
    }),
    async (p) => {
      if (p.buildSlug === undefined) {
        return jsonResult(await bitriseGet(`/v0.1/apps/${encodeURIComponent(p.appSlug)}`));
      }
      const path = `/v0.1/apps/${encodeURIComponent(p.appSlug)}/builds/${encodeURIComponent(p.buildSlug)}`;
      return jsonResult(await bitriseGet(path));
    },
  );

  reg(
    "bitrise_search",
    "Substring search across a Bitrise app's recent builds. Matches the query against `branch`, `commit_message`, `triggered_workflow`, and `status_text` (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    z.object({
      appSlug: z.string().min(1),
      query: z.string().min(1),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    async (p) => {
      const root = await bitriseGet(`/v0.1/apps/${encodeURIComponent(p.appSlug)}/builds?limit=50`);
      const data = (root as { data?: unknown[] } | null)?.data;
      return matchesResult(data, filterBitriseBuilds, p);
    },
  );
});
