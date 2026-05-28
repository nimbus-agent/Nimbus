import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
} from "../../shared/mcp-tool-kit.ts";

function siteHost(): string {
  const s = process.env["DD_SITE"]?.trim() || "datadoghq.com";
  return `api.${s}`;
}

function headers(): Record<string, string> {
  const ak = process.env["DD_API_KEY"]?.trim();
  const app = process.env["DD_APP_KEY"]?.trim();
  if (ak === undefined || ak === "" || app === undefined || app === "") {
    throw new Error("DD_API_KEY and DD_APP_KEY must be set");
  }
  return {
    "DD-API-KEY": ak,
    "DD-APPLICATION-KEY": app,
    Accept: "application/json",
  };
}

async function ddGet(path: string): Promise<unknown> {
  const res = await fetch(`https://${siteHost()}${path}`, { headers: headers() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Datadog ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

const mcp = new McpServer({ name: "nimbus-datadog", version: "0.1.0" });
const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));

reg("datadog_monitor_list", "List monitors.", z.object({}), async () =>
  jsonResult(await ddGet("/api/v1/monitor")),
);

reg(
  "datadog_incident_list",
  "List incidents (v2).",
  z.object({ limit: z.number().int().min(1).max(50).optional() }),
  async (p) => {
    const lim = p.limit ?? 10;
    return jsonResult(await ddGet(`/api/v2/incidents?page[size]=${String(lim)}`));
  },
);

const transport = new StdioServerTransport();
await mcp.connect(transport);
