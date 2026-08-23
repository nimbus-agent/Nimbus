import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
} from "../../shared/mcp-tool-kit.ts";
import { runCliJson, runCliOk } from "../../shared/run-cli-json.ts";

function azEnv(): Record<string, string | undefined> {
  return { ...process.env } as Record<string, string | undefined>;
}

async function azJson(args: string[]): Promise<unknown> {
  const cmd = ["az", ...args, "-o", "json"];
  const r = await runCliJson(cmd, azEnv());
  if (!r.ok) {
    throw new Error(r.message);
  }
  return r.data ?? {};
}

const mcp = new McpServer({ name: "nimbus-azure", version: "0.1.0" });

import { createWriteToolRegistrar } from "../../shared/consent-kit.ts";

const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));

/**
 * Every MUTATING azure tool goes through here. Outside the gateway this adds the
 * consent gate, the write-scope allow-list, the mutation budget and the audit record; inside
 * the gateway it is a pass-through, because executor.ts (I2) is the gate there.
 */
const registerWriteTool = createWriteToolRegistrar(mcp, {
  connector: "azure",
  scopeEnv: "NIMBUS_MCP_AZURE_WRITE_SCOPE",
  scopeKinds: ["resource_group"],
});

reg(
  "azure_app_service_list",
  "List App Services in a resource group.",
  z.object({
    subscriptionId: z.string().min(1),
    resourceGroup: z.string().min(1),
  }),
  async (p) =>
    jsonResult(
      await azJson([
        "webapp",
        "list",
        "--subscription",
        p.subscriptionId,
        "--resource-group",
        p.resourceGroup,
      ]),
    ),
);

registerWriteTool(
  "azure_app_service_restart",
  {
    mutates: "azure.app_service.restart",
    recoverable: true,
    scopeTargetOf: (p) => ({ kind: "resource_group", value: p.resourceGroup }),
  },
  "Restart an App Service.",
  z.object({
    subscriptionId: z.string().min(1),
    resourceGroup: z.string().min(1),
    name: z.string().min(1),
  }),
  async (p) => {
    const r = await runCliOk(
      [
        "az",
        "webapp",
        "restart",
        "--subscription",
        p.subscriptionId,
        "--resource-group",
        p.resourceGroup,
        "--name",
        p.name,
      ],
      azEnv(),
    );
    if (!r.ok) {
      throw new Error(r.message);
    }
    return jsonResult({ ok: true });
  },
);

registerWriteTool(
  "azure_aks_node_pool_scale",
  {
    mutates: "azure.aks.node_pool.scale",
    recoverable: true,
    scopeTargetOf: (p) => ({ kind: "resource_group", value: p.resourceGroup }),
  },
  "Scale an AKS node pool.",
  z.object({
    subscriptionId: z.string().min(1),
    resourceGroup: z.string().min(1),
    clusterName: z.string().min(1),
    poolName: z.string().min(1),
    nodeCount: z.number().int().min(0),
  }),
  async (p) => {
    const r = await runCliOk(
      [
        "az",
        "aks",
        "nodepool",
        "scale",
        "--subscription",
        p.subscriptionId,
        "--resource-group",
        p.resourceGroup,
        "--cluster-name",
        p.clusterName,
        "--name",
        p.poolName,
        "--node-count",
        String(p.nodeCount),
      ],
      azEnv(),
    );
    if (!r.ok) {
      throw new Error(r.message);
    }
    return jsonResult({ ok: true });
  },
);

const transport = new StdioServerTransport();
await mcp.connect(transport);
