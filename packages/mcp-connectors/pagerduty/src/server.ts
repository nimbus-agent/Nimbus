import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
  requireProcessEnv,
} from "../../shared/mcp-tool-kit.ts";
import { makeRestToolRegistrar } from "../../shared/rest-tool-kit.ts";

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

import { createWriteToolRegistrar } from "../../shared/consent-kit.ts";

const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));

/**
 * Every MUTATING pagerduty tool goes through here. Outside the gateway this adds the
 * consent gate, the write-scope allow-list, the mutation budget and the audit record; inside
 * the gateway it is a pass-through, because executor.ts (I2) is the gate there.
 */
const registerWriteTool = createWriteToolRegistrar(mcp, {
  connector: "pagerduty",
  scopeEnv: "NIMBUS_MCP_PAGERDUTY_WRITE_SCOPE",
  scopeKinds: ["incident"],
});

/** Standard PagerDuty read tool: token → pdFetch(buildPath) → mcpJsonResultIfOk("PagerDuty"). */
const registerPdTool = makeRestToolRegistrar({
  registrar: reg,
  tokenEnv: "PAGERDUTY_API_TOKEN",
  serviceLabel: "PagerDuty",
  fetch: pdFetch,
});

registerPdTool(
  "pd_incident_list",
  "List PagerDuty incidents (open and recently resolved).",
  z.object({
    statuses: z.array(z.enum(["triggered", "acknowledged", "resolved"])).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  (parsed) => {
    const u = new URL(`${API}/incidents`);
    u.searchParams.set("limit", String(parsed.limit ?? 25));
    const st = parsed.statuses ?? ["triggered", "acknowledged"];
    for (const s of st) {
      u.searchParams.append("statuses[]", s);
    }
    return `${u.pathname}${u.search}`;
  },
);

registerPdTool(
  "pd_incident_get",
  "Get a single incident by id.",
  z.object({ incidentId: z.string().min(1) }),
  (parsed) => `/incidents/${encodeURIComponent(parsed.incidentId)}`,
);

registerWriteTool(
  "pd_incident_acknowledge",
  {
    mutates: "pagerduty.incident.acknowledge",
    recoverable: true,
    scopeTargetOf: (p) => ({ kind: "incident", value: p.incidentId }),
  },
  "Acknowledge an incident.",
  z.object({ incidentId: z.string().min(1) }),
  async (parsed) => pdIncidentPutMutation("acknowledge", "acknowledge", parsed.incidentId),
);

registerWriteTool(
  "pd_incident_resolve",
  {
    mutates: "pagerduty.incident.resolve",
    recoverable: true,
    scopeTargetOf: (p) => ({ kind: "incident", value: p.incidentId }),
  },
  "Resolve an incident.",
  z.object({ incidentId: z.string().min(1) }),
  async (parsed) => pdIncidentPutMutation("resolve", "resolve", parsed.incidentId),
);

registerWriteTool(
  "pd_incident_escalate",
  {
    mutates: "pagerduty.incident.escalate",
    recoverable: true,
    scopeTargetOf: (p) => ({ kind: "incident", value: p.incidentId }),
  },
  "Escalate an incident.",
  z.object({ incidentId: z.string().min(1) }),
  async (parsed) => pdIncidentPutMutation("escalate", "escalate", parsed.incidentId),
);

const transport = new StdioServerTransport();
await mcp.connect(transport);
