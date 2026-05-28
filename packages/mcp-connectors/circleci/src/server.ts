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

const CCI_API = "https://circleci.com/api/v2";

function projectPathSegments(projectSlug: string): string {
  return projectSlug
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => encodeURIComponent(s))
    .join("/");
}

async function circleciFetch(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const url = path.startsWith("http") ? path : `${CCI_API}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      "Circle-Token": token,
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

async function circleciAuthorizedJsonResult(path: string) {
  const token = requireProcessEnv("CIRCLECI_API_TOKEN");
  const res = await circleciFetch(token, path);
  return mcpJsonResultIfOk("CircleCI", res);
}

const mcp = new McpServer({ name: "nimbus-circleci", version: "0.1.0" });
const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));

const projectSlugSchema = z.object({
  projectSlug: z
    .string()
    .min(3)
    .describe("CircleCI project slug, e.g. gh/org/repo or bb/workspace/repo"),
});

reg(
  "circleci_pipeline_list",
  "List pipelines for a CircleCI project.",
  projectSlugSchema.extend({
    pageToken: z.string().min(1).optional(),
  }),
  async (parsed) => {
    const base = `/project/${projectPathSegments(parsed.projectSlug)}/pipeline`;
    const u = new URL(`${CCI_API}${base}`);
    if (parsed.pageToken !== undefined) {
      u.searchParams.set("page-token", parsed.pageToken);
    }
    return circleciAuthorizedJsonResult(`${u.pathname}${u.search}`);
  },
);

reg(
  "circleci_pipeline_get",
  "Get a pipeline by UUID.",
  z.object({ pipelineId: z.string().uuid() }),
  async (parsed) => {
    const path = `/pipeline/${encodeURIComponent(parsed.pipelineId)}`;
    return circleciAuthorizedJsonResult(path);
  },
);

reg(
  "circleci_workflow_list",
  "List workflows for a pipeline.",
  z.object({ pipelineId: z.string().uuid() }),
  async (parsed) => {
    const path = `/pipeline/${encodeURIComponent(parsed.pipelineId)}/workflow`;
    return circleciAuthorizedJsonResult(path);
  },
);

reg(
  "circleci_job_list",
  "List jobs for a workflow.",
  z.object({ workflowId: z.string().uuid() }),
  async (parsed) => {
    const path = `/workflow/${encodeURIComponent(parsed.workflowId)}/job`;
    return circleciAuthorizedJsonResult(path);
  },
);

reg(
  "circleci_job_artifacts",
  "List artifact metadata for a job number under a project.",
  projectSlugSchema.extend({
    jobNumber: z.number().int().min(1),
  }),
  async (parsed) => {
    const path = `/project/${projectPathSegments(parsed.projectSlug)}/job/${String(parsed.jobNumber)}/artifacts`;
    return circleciAuthorizedJsonResult(path);
  },
);

reg(
  "circleci_pipeline_trigger",
  "Trigger a new pipeline on a branch (or tag). Requires Gateway HITL.",
  projectSlugSchema.extend({
    branch: z.string().min(1).optional(),
    tag: z.string().min(1).optional(),
    parameters: z.record(z.string(), z.string()).optional(),
  }),
  async (parsed) => {
    const token = requireProcessEnv("CIRCLECI_API_TOKEN");
    const path = `/project/${projectPathSegments(parsed.projectSlug)}/pipeline`;
    const body: Record<string, unknown> = {};
    if (parsed.tag !== undefined && parsed.tag !== "") {
      body["tag"] = parsed.tag;
    } else {
      body["branch"] = parsed.branch ?? "main";
    }
    if (parsed.parameters !== undefined && Object.keys(parsed.parameters).length > 0) {
      body["parameters"] = parsed.parameters;
    }
    const res = await circleciFetch(token, path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`CircleCI trigger ${String(res.status)}: ${res.text.slice(0, 400)}`);
    }
    return jsonResult(res.json ?? { ok: true, raw: res.text });
  },
);

reg(
  "circleci_job_cancel",
  "Cancel a running job by project slug and job number. Requires Gateway HITL.",
  projectSlugSchema.extend({
    jobNumber: z.number().int().min(1),
  }),
  async (parsed) => {
    const token = requireProcessEnv("CIRCLECI_API_TOKEN");
    const path = `/project/${projectPathSegments(parsed.projectSlug)}/job/${String(parsed.jobNumber)}/cancel`;
    const res = await circleciFetch(token, path, { method: "POST" });
    if (!res.ok) {
      throw new Error(`CircleCI job cancel ${String(res.status)}: ${res.text.slice(0, 400)}`);
    }
    return jsonResult(res.json ?? { ok: true });
  },
);

const transport = new StdioServerTransport();
await mcp.connect(transport);
