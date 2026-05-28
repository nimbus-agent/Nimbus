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
import { stripTrailingSlashes } from "../../shared/strip-trailing-slashes.ts";

function apiBase(): string {
  const b = process.env["GITLAB_API_BASE_URL"];
  if (b !== undefined && b.trim() !== "") {
    return stripTrailingSlashes(b);
  }
  return "https://gitlab.com/api/v4";
}

async function glFetch(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const base = apiBase();
  const relativePath = path.startsWith("/") ? path : `/${path}`;
  const url = path.startsWith("http") ? path : `${base}${relativePath}`;
  const baseHeaders: Record<string, string> = { "PRIVATE-TOKEN": token };
  const mergedHeaders =
    init?.headers === undefined
      ? baseHeaders
      : { ...baseHeaders, ...(init.headers as Record<string, string>) };
  const res = await fetch(url, {
    ...init,
    headers: mergedHeaders,
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

const server = new McpServer({ name: "nimbus-gitlab", version: "0.1.0" });

const registerSimpleTool = createRegisterSimpleTool(server);
const reg = createZodToolRegistrar(registerSimpleTool);

const projectPathArg = z.object({
  projectPath: z
    .string()
    .min(1)
    .describe("URL-encoded path or numeric project id, e.g. group/repo"),
});

const gitlabProjectListSchema = z.object({
  perPage: z.number().int().min(1).max(100).optional(),
  page: z.number().int().min(1).optional(),
});

reg(
  "gitlab_project_list",
  "List projects visible to the authenticated user (membership).",
  gitlabProjectListSchema,
  async (parsed) => {
    const token = requireProcessEnv("GITLAB_PAT");
    const u = new URL(`${apiBase()}/projects`);
    u.searchParams.set("membership", "true");
    u.searchParams.set("order_by", "last_activity_at");
    u.searchParams.set("sort", "desc");
    u.searchParams.set("per_page", String(parsed.perPage ?? 30));
    if (parsed.page !== undefined) {
      u.searchParams.set("page", String(parsed.page));
    }
    const res = await glFetch(token, `${u.pathname}${u.search}`);
    return mcpJsonResultIfOk("GitLab", res);
  },
);

const gitlabMrListSchema = projectPathArg.extend({
  state: z.enum(["opened", "closed", "locked", "merged", "all"]).optional(),
  perPage: z.number().int().min(1).max(100).optional(),
  page: z.number().int().min(1).optional(),
});

reg("gitlab_mr_list", "List merge requests for a project.", gitlabMrListSchema, async (parsed) => {
  const token = requireProcessEnv("GITLAB_PAT");
  const enc = encodeURIComponent(parsed.projectPath);
  const u = new URL(`${apiBase()}/projects/${enc}/merge_requests`);
  u.searchParams.set("state", parsed.state ?? "opened");
  u.searchParams.set("per_page", String(parsed.perPage ?? 30));
  if (parsed.page !== undefined) {
    u.searchParams.set("page", String(parsed.page));
  }
  const res = await glFetch(token, `${u.pathname}${u.search}`);
  return mcpJsonResultIfOk("GitLab", res);
});

const gitlabMrGetSchema = projectPathArg.extend({
  mergeRequestIid: z.number().int().min(1),
});

reg("gitlab_mr_get", "Get a single merge request by IID.", gitlabMrGetSchema, async (parsed) => {
  const token = requireProcessEnv("GITLAB_PAT");
  const enc = encodeURIComponent(parsed.projectPath);
  const path = `/projects/${enc}/merge_requests/${String(parsed.mergeRequestIid)}`;
  const res = await glFetch(token, path);
  return mcpJsonResultIfOk("GitLab", res);
});

const gitlabMrMergeSchema = projectPathArg.extend({
  mergeRequestIid: z.number().int().min(1),
  mergeCommitMessage: z.string().max(10_000).optional(),
  squash: z.boolean().optional(),
  shouldRemoveSourceBranch: z.boolean().optional(),
});

reg(
  "gitlab_mr_merge",
  "Merge a merge request (requires HITL repo.pr.merge).",
  gitlabMrMergeSchema,
  async (parsed) => {
    const token = requireProcessEnv("GITLAB_PAT");
    const enc = encodeURIComponent(parsed.projectPath);
    const path = `/projects/${enc}/merge_requests/${String(parsed.mergeRequestIid)}/merge`;
    const body: Record<string, unknown> = {};
    if (parsed.mergeCommitMessage !== undefined) {
      body["merge_commit_message"] = parsed.mergeCommitMessage;
    }
    if (parsed.squash !== undefined) {
      body["squash"] = parsed.squash;
    }
    if (parsed.shouldRemoveSourceBranch !== undefined) {
      body["should_remove_source_branch"] = parsed.shouldRemoveSourceBranch;
    }
    const res = await glFetch(token, path, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return mcpJsonResultIfOk("GitLab", res);
  },
);

const gitlabIssueListSchema = projectPathArg.extend({
  state: z.enum(["opened", "closed", "all"]).optional(),
  perPage: z.number().int().min(1).max(100).optional(),
  page: z.number().int().min(1).optional(),
});

reg("gitlab_issue_list", "List issues for a project.", gitlabIssueListSchema, async (parsed) => {
  const token = requireProcessEnv("GITLAB_PAT");
  const enc = encodeURIComponent(parsed.projectPath);
  const u = new URL(`${apiBase()}/projects/${enc}/issues`);
  u.searchParams.set("state", parsed.state ?? "opened");
  u.searchParams.set("per_page", String(parsed.perPage ?? 30));
  if (parsed.page !== undefined) {
    u.searchParams.set("page", String(parsed.page));
  }
  const res = await glFetch(token, `${u.pathname}${u.search}`);
  return mcpJsonResultIfOk("GitLab", res);
});

const gitlabIssueGetSchema = projectPathArg.extend({
  issueIid: z.number().int().min(1),
});

reg("gitlab_issue_get", "Get a single issue by IID.", gitlabIssueGetSchema, async (parsed) => {
  const token = requireProcessEnv("GITLAB_PAT");
  const enc = encodeURIComponent(parsed.projectPath);
  const path = `/projects/${enc}/issues/${String(parsed.issueIid)}`;
  const res = await glFetch(token, path);
  return mcpJsonResultIfOk("GitLab", res);
});

const gitlabPipelineListSchema = projectPathArg.extend({
  ref: z.string().max(500).optional(),
  status: z.string().max(64).optional(),
  perPage: z.number().int().min(1).max(100).optional(),
  page: z.number().int().min(1).optional(),
});

reg(
  "gitlab_pipeline_list",
  "List CI pipelines for a project.",
  gitlabPipelineListSchema,
  async (parsed) => {
    const token = requireProcessEnv("GITLAB_PAT");
    const enc = encodeURIComponent(parsed.projectPath);
    const u = new URL(`${apiBase()}/projects/${enc}/pipelines`);
    u.searchParams.set("per_page", String(parsed.perPage ?? 30));
    if (parsed.page !== undefined) {
      u.searchParams.set("page", String(parsed.page));
    }
    if (parsed.ref !== undefined) {
      u.searchParams.set("ref", parsed.ref);
    }
    if (parsed.status !== undefined) {
      u.searchParams.set("status", parsed.status);
    }
    const res = await glFetch(token, `${u.pathname}${u.search}`);
    return mcpJsonResultIfOk("GitLab", res);
  },
);

const gitlabPipelineGetSchema = projectPathArg.extend({
  pipelineId: z.number().int().min(1),
});

reg(
  "gitlab_pipeline_get",
  "Get a single pipeline by id.",
  gitlabPipelineGetSchema,
  async (parsed) => {
    const token = requireProcessEnv("GITLAB_PAT");
    const enc = encodeURIComponent(parsed.projectPath);
    const path = `/projects/${enc}/pipelines/${String(parsed.pipelineId)}`;
    const res = await glFetch(token, path);
    return mcpJsonResultIfOk("GitLab", res);
  },
);

const gitlabJobTraceSchema = projectPathArg.extend({
  jobId: z.number().int().min(1),
});

reg(
  "gitlab_job_trace",
  "Download plain-text trace for a CI job (by job id).",
  gitlabJobTraceSchema,
  async (parsed) => {
    const token = requireProcessEnv("GITLAB_PAT");
    const enc = encodeURIComponent(parsed.projectPath);
    const url = `${apiBase()}/projects/${enc}/jobs/${String(parsed.jobId)}/trace`;
    const res = await fetch(url, { headers: { "PRIVATE-TOKEN": token } });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`GitLab ${String(res.status)}: ${text.slice(0, 300)}`);
    }
    return jsonResult({ trace: text });
  },
);

reg(
  "gitlab_pipeline_jobs_get",
  "List jobs for a CI pipeline (by pipeline id).",
  gitlabPipelineGetSchema,
  async (parsed) => {
    const token = requireProcessEnv("GITLAB_PAT");
    const enc = encodeURIComponent(parsed.projectPath);
    const path = `/projects/${enc}/pipelines/${String(parsed.pipelineId)}/jobs`;
    const res = await glFetch(token, path);
    return mcpJsonResultIfOk("GitLab", res);
  },
);

reg(
  "gitlab_job_log_tail",
  "Download job trace text, optionally keeping only the last N characters (tail).",
  gitlabJobTraceSchema.extend({
    maxChars: z.number().int().min(1000).max(500_000).optional(),
  }),
  async (parsed) => {
    const token = requireProcessEnv("GITLAB_PAT");
    const enc = encodeURIComponent(parsed.projectPath);
    const url = `${apiBase()}/projects/${enc}/jobs/${String(parsed.jobId)}/trace`;
    const res = await fetch(url, { headers: { "PRIVATE-TOKEN": token } });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`GitLab ${String(res.status)}: ${text.slice(0, 300)}`);
    }
    const max = parsed.maxChars ?? 64_000;
    const tail = text.length > max ? text.slice(-max) : text;
    return jsonResult({
      jobId: parsed.jobId,
      truncated: text.length > max,
      totalChars: text.length,
      trace: tail,
    });
  },
);

reg(
  "gitlab_pipeline_retry",
  "Retry failed jobs in a pipeline. Requires Gateway HITL.",
  gitlabPipelineGetSchema,
  async (parsed) => {
    const token = requireProcessEnv("GITLAB_PAT");
    const enc = encodeURIComponent(parsed.projectPath);
    const path = `/projects/${enc}/pipelines/${String(parsed.pipelineId)}/retry`;
    const res = await glFetch(token, path, { method: "POST" });
    if (!res.ok) {
      throw new Error(`GitLab pipeline retry ${String(res.status)}: ${res.text.slice(0, 400)}`);
    }
    return mcpJsonResultIfOk("GitLab", res);
  },
);

reg(
  "gitlab_pipeline_cancel",
  "Cancel a pipeline. Requires Gateway HITL.",
  gitlabPipelineGetSchema,
  async (parsed) => {
    const token = requireProcessEnv("GITLAB_PAT");
    const enc = encodeURIComponent(parsed.projectPath);
    const path = `/projects/${enc}/pipelines/${String(parsed.pipelineId)}/cancel`;
    const res = await glFetch(token, path, { method: "POST" });
    if (!res.ok) {
      throw new Error(`GitLab pipeline cancel ${String(res.status)}: ${res.text.slice(0, 400)}`);
    }
    return mcpJsonResultIfOk("GitLab", res);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
