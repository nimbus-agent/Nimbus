import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
} from "../../shared/mcp-tool-kit.ts";
import { runCliJson, runCliOk } from "../../shared/run-cli-json.ts";

function gcloudEnv(): Record<string, string | undefined> {
  const e = { ...process.env } as Record<string, string | undefined>;
  const cf = process.env["GOOGLE_APPLICATION_CREDENTIALS"]?.trim();
  if (cf !== undefined && cf !== "") {
    e["GOOGLE_APPLICATION_CREDENTIALS"] = cf;
  }
  return e;
}

async function gcloudJson(args: string[]): Promise<unknown> {
  const cmd = ["gcloud", ...args, "--format", "json"];
  const r = await runCliJson(cmd, gcloudEnv());
  if (!r.ok) {
    throw new Error(r.message);
  }
  return r.data ?? {};
}

const mcp = new McpServer({ name: "nimbus-gcp", version: "0.1.0" });

import { createWriteToolRegistrar } from "../../shared/consent-kit.ts";

const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));

/**
 * Every MUTATING gcp tool goes through here. Outside the gateway this adds the
 * consent gate, the write-scope allow-list, the mutation budget and the audit record; inside
 * the gateway it is a pass-through, because executor.ts (I2) is the gate there.
 */
const registerWriteTool = createWriteToolRegistrar(mcp, {
  connector: "gcp",
  scopeEnv: "NIMBUS_MCP_GCP_WRITE_SCOPE",
  scopeKinds: ["project"],
});

reg(
  "gcp_cloud_run_service_list",
  "List Cloud Run services in a region.",
  z.object({ projectId: z.string().min(1), region: z.string().min(1) }),
  async (p) =>
    jsonResult(
      await gcloudJson([
        "run",
        "services",
        "list",
        `--project=${p.projectId}`,
        `--region=${p.region}`,
      ]),
    ),
);

registerWriteTool(
  "gcp_cloud_run_deploy",
  {
    mutates: "gcp.cloud_run.deploy",
    recoverable: true,
    scopeTargetOf: (p) => ({ kind: "project", value: p.projectId }),
  },
  "Deploy a container image to Cloud Run.",
  z.object({
    projectId: z.string().min(1),
    region: z.string().min(1),
    service: z.string().min(1),
    image: z.string().min(1),
  }),
  async (p) => {
    const r = await runCliOk(
      [
        "gcloud",
        "run",
        "deploy",
        p.service,
        `--project=${p.projectId}`,
        `--region=${p.region}`,
        `--image=${p.image}`,
        "--quiet",
      ],
      gcloudEnv(),
    );
    if (!r.ok) {
      throw new Error(r.message);
    }
    return jsonResult({ ok: true });
  },
);

registerWriteTool(
  "gcp_gke_workload_restart",
  {
    mutates: "gcp.gke.workload.restart",
    recoverable: true,
    scopeTargetOf: (p) => ({ kind: "project", value: p.projectId }),
  },
  "Restart a GKE deployment rollout via kubectl (uses current cluster credentials).",
  z.object({
    projectId: z.string().min(1),
    location: z.string().min(1),
    cluster: z.string().min(1),
    namespace: z.string().min(1),
    deployment: z.string().min(1),
  }),
  async (p) => {
    const getCreds = await runCliOk(
      [
        "gcloud",
        "container",
        "clusters",
        "get-credentials",
        p.cluster,
        `--project=${p.projectId}`,
        `--zone=${p.location}`,
      ],
      gcloudEnv(),
    );
    if (!getCreds.ok) {
      throw new Error(getCreds.message);
    }
    const r = await runCliOk(
      ["kubectl", "rollout", "restart", "deployment", p.deployment, "-n", p.namespace],
      gcloudEnv(),
    );
    if (!r.ok) {
      throw new Error(r.message);
    }
    return jsonResult({ ok: true });
  },
);

const transport = new StdioServerTransport();
await mcp.connect(transport);
