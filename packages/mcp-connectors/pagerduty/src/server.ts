import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
  mcpJsonResultIfOk,
  requireProcessEnv,
} from "../../shared/mcp-tool-kit.ts";

const API = "https://api.pagerduty.com";

async function pdFetch(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const rel = path.startsWith("/") ? path : `/${path}`;
  const url = path.startsWith("http") ? path : `${API}${rel}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/vnd.pagerduty+json;version=2",
      Authorization: `Token token=${token}`,
      "Content-Type": "application/json",
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, text };
}

async function pdIncidentPutMutation(actionLabel: string, pathSuffix: string, incidentId: string) {
  const token = requireProcessEnv("PAGERDUTY_API_TOKEN");
  const res = await pdFetch(token, `/incidents/${encodeURIComponent(incidentId)}/${pathSuffix}`, {
    method: "PUT",
    body: JSON.stringify({ incident: { type: "incident_reference", id: incidentId } }),
  });
  if (!res.ok) {
    throw new Error(`PagerDuty ${actionLabel} ${String(res.status)}: ${res.text.slice(0, 400)}`);
  }
  return jsonResult(res.json ?? { ok: true });
}

const mcp = new McpServer({ name: "nimbus-pagerduty", version: "0.1.0" });
const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));

reg(
  "pd_incident_list",
  "List PagerDuty incidents (open and recently resolved).",
  z.object({
    statuses: z.array(z.enum(["triggered", "acknowledged", "resolved"])).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  async (parsed) => {
    const token = requireProcessEnv("PAGERDUTY_API_TOKEN");
    const u = new URL(`${API}/incidents`);
    u.searchParams.set("limit", String(parsed.limit ?? 25));
    const st = parsed.statuses ?? ["triggered", "acknowledged"];
    for (const s of st) {
      u.searchParams.append("statuses[]", s);
    }
    const res = await pdFetch(token, `${u.pathname}${u.search}`);
    return mcpJsonResultIfOk("PagerDuty", res);
  },
);

reg(
  "pd_incident_get",
  "Get a single incident by id.",
  z.object({ incidentId: z.string().min(1) }),
  async (parsed) => {
    const token = requireProcessEnv("PAGERDUTY_API_TOKEN");
    const res = await pdFetch(token, `/incidents/${encodeURIComponent(parsed.incidentId)}`);
    return mcpJsonResultIfOk("PagerDuty", res);
  },
);

reg(
  "pd_incident_acknowledge",
  "Acknowledge an incident. Requires Gateway HITL.",
  z.object({ incidentId: z.string().min(1) }),
  async (parsed) => pdIncidentPutMutation("acknowledge", "acknowledge", parsed.incidentId),
);

reg(
  "pd_incident_resolve",
  "Resolve an incident. Requires Gateway HITL.",
  z.object({ incidentId: z.string().min(1) }),
  async (parsed) => pdIncidentPutMutation("resolve", "resolve", parsed.incidentId),
);

reg(
  "pd_incident_escalate",
  "Escalate an incident. Requires Gateway HITL.",
  z.object({ incidentId: z.string().min(1) }),
  async (parsed) => pdIncidentPutMutation("escalate", "escalate", parsed.incidentId),
);

const transport = new StdioServerTransport();
await mcp.connect(transport);
