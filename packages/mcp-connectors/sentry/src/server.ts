import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
} from "../../shared/mcp-tool-kit.ts";

function apiRoot(): string {
  const u = process.env["SENTRY_URL"]?.trim() || "https://sentry.io";
  return `${u.replace(/\/$/, "")}/api/0`;
}

function org(): string {
  const o = process.env["SENTRY_ORG_SLUG"]?.trim();
  if (o === undefined || o === "") {
    throw new Error("SENTRY_ORG_SLUG is not set");
  }
  return o;
}

function headers(): Record<string, string> {
  const t = process.env["SENTRY_AUTH_TOKEN"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("SENTRY_AUTH_TOKEN is not set");
  }
  return { Authorization: `Bearer ${t}`, Accept: "application/json" };
}

async function sentryGet(path: string): Promise<unknown> {
  const res = await fetch(`${apiRoot()}${path}`, { headers: headers() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Sentry ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

const mcp = new McpServer({ name: "nimbus-sentry", version: "0.1.0" });
const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));

reg(
  "sentry_issue_list",
  "List unresolved issues for a project.",
  z.object({ projectSlug: z.string().min(1), limit: z.number().int().min(1).max(100).optional() }),
  async (p) => {
    const lim = p.limit ?? 20;
    return jsonResult(
      await sentryGet(
        `/projects/${org()}/${p.projectSlug}/issues/?query=is:unresolved&limit=${String(lim)}`,
      ),
    );
  },
);

reg(
  "sentry_release_list",
  "List releases for a project.",
  z.object({ projectSlug: z.string().min(1) }),
  async (p) => jsonResult(await sentryGet(`/projects/${org()}/${p.projectSlug}/releases/`)),
);

const transport = new StdioServerTransport();
await mcp.connect(transport);
