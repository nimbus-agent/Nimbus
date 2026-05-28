import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
} from "../../shared/mcp-tool-kit.ts";

function apiKey(): string {
  const k = process.env["NEW_RELIC_API_KEY"]?.trim();
  if (k === undefined || k === "") {
    throw new Error("NEW_RELIC_API_KEY is not set");
  }
  return k;
}

async function nrGet(path: string): Promise<unknown> {
  const res = await fetch(`https://api.newrelic.com${path}`, {
    headers: { "X-Api-Key": apiKey(), Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`New Relic ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

const mcp = new McpServer({ name: "nimbus-newrelic", version: "0.1.0" });
const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));

reg("newrelic_application_list", "List APM applications.", z.object({}), async () =>
  jsonResult(await nrGet("/v2/applications.json")),
);

reg(
  "newrelic_alert_violations",
  "List recent alert violations.",
  z.object({ only_open: z.boolean().optional() }),
  async (p) => {
    const only = p.only_open === true ? "true" : "false";
    return jsonResult(await nrGet(`/v2/alerts_violations.json?only_open=${only}`));
  },
);

const transport = new StdioServerTransport();
await mcp.connect(transport);
