import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { fetchBearerAuthorizedJson, resolveUrlWithBase } from "../../shared/fetch-bearer-json.ts";
import { createRegisterSimpleTool, createZodToolRegistrar } from "../../shared/mcp-tool-kit.ts";
import { makeRestToolRegistrar } from "../../shared/rest-tool-kit.ts";

const MEET_BASE = "https://meet.googleapis.com/v2";

async function meetFetch(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const url = resolveUrlWithBase(MEET_BASE, path);
  return fetchBearerAuthorizedJson(url, token, init, { "Content-Type": "application/json" });
}

const server = new McpServer({ name: "nimbus-google-meet", version: "0.1.0" });

const registerSimpleTool = createRegisterSimpleTool(server);
const reg = createZodToolRegistrar(registerSimpleTool);

/** Standard Meet read tool: token → meetFetch(buildPath) → mcpJsonResultIfOk("Google Meet API"). */
const registerMeetTool = makeRestToolRegistrar({
  registrar: reg,
  tokenEnv: "GOOGLE_OAUTH_ACCESS_TOKEN",
  serviceLabel: "Google Meet API",
  fetch: meetFetch,
});

const gmeetListArgs = z.object({
  pageSize: z.number().int().min(1).max(100).optional(),
  pageToken: z.string().optional(),
});

registerMeetTool(
  "google_meet_list",
  "List past Google Meet conference records (metadata: id, startTime, endTime, space). Pagination via pageToken.",
  gmeetListArgs,
  (parsed) => {
    const u = new URL(`${MEET_BASE}/conferenceRecords`);
    u.searchParams.set("pageSize", String(parsed.pageSize ?? 50));
    if (parsed.pageToken !== undefined && parsed.pageToken !== "") {
      u.searchParams.set("pageToken", parsed.pageToken);
    }
    return `${u.pathname}${u.search}`;
  },
);

const gmeetGetArgs = z.object({
  conferenceRecordId: z.string().min(1),
});

registerMeetTool(
  "google_meet_get",
  "Get a single Google Meet conference record by id (startTime, endTime, space).",
  gmeetGetArgs,
  (parsed) => `/conferenceRecords/${encodeURIComponent(parsed.conferenceRecordId)}`,
);

const gmeetSearchArgs = z.object({
  pageSize: z.number().int().min(1).max(100).optional(),
  pageToken: z.string().optional(),
  filter: z.string().optional(),
});

registerMeetTool(
  "google_meet_search",
  "Search past conference records (metadata only). Supports the Meet API filter expression and pagination.",
  gmeetSearchArgs,
  (parsed) => {
    const u = new URL(`${MEET_BASE}/conferenceRecords`);
    u.searchParams.set("pageSize", String(parsed.pageSize ?? 50));
    if (parsed.pageToken !== undefined && parsed.pageToken !== "") {
      u.searchParams.set("pageToken", parsed.pageToken);
    }
    if (parsed.filter !== undefined && parsed.filter !== "") {
      u.searchParams.set("filter", parsed.filter);
    }
    return `${u.pathname}${u.search}`;
  },
);

await server.connect(new StdioServerTransport());
