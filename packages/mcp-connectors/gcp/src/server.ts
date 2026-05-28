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
const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));

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

reg(
  "gcp_cloud_run_deploy",
  "Deploy a container image to Cloud Run. HITL.",
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

reg(
  "gcp_gke_workload_restart",
  "Restart a GKE deployment rollout via kubectl (uses current cluster credentials). HITL.",
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
