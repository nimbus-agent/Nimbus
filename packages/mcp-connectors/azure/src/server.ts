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
const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));

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

reg(
  "azure_app_service_restart",
  "Restart an App Service. HITL.",
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

reg(
  "azure_aks_node_pool_scale",
  "Scale an AKS node pool. HITL.",
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
