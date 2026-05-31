import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { fetchBearerAuthorizedJson } from "../../shared/fetch-bearer-json.ts";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
  mcpJsonResultIfOk,
  requireProcessEnv,
} from "../../shared/mcp-tool-kit.ts";

const GH_API = "https://api.github.com";
const GH_HEADERS: Record<string, string> = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

async function ghFetch(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const url = path.startsWith("http") ? path : `${GH_API}${path}`;
  return fetchBearerAuthorizedJson(url, token, init, GH_HEADERS);
}

const mcp = new McpServer({ name: "nimbus-github-actions", version: "0.1.0" });
const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));

const repoSlugArgs = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
});

const runListSchema = repoSlugArgs.extend({
  perPage: z.number().int().min(1).max(100).optional(),
  page: z.number().int().min(1).optional(),
  branch: z.string().optional(),
  event: z.string().optional(),
  status: z.string().optional(),
});

reg(
  "gha_workflow_list",
  "List GitHub Actions workflows for a repository.",
  repoSlugArgs.extend({
    perPage: z.number().int().min(1).max(100).optional(),
    page: z.number().int().min(1).optional(),
  }),
  async (parsed) => {
    const token = requireProcessEnv("GITHUB_PAT");
    const u = new URL(
      `${GH_API}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/actions/workflows`,
    );
    u.searchParams.set("per_page", String(parsed.perPage ?? 30));
    if (parsed.page !== undefined) {
      u.searchParams.set("page", String(parsed.page));
    }
    const res = await ghFetch(token, `${u.pathname}${u.search}`);
    return mcpJsonResultIfOk("GitHub Actions", res);
  },
);

reg("gha_run_list", "List workflow runs for a repository.", runListSchema, async (parsed) => {
  const token = requireProcessEnv("GITHUB_PAT");
  const u = new URL(
    `${GH_API}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/actions/runs`,
  );
  u.searchParams.set("per_page", String(parsed.perPage ?? 30));
  if (parsed.page !== undefined) {
    u.searchParams.set("page", String(parsed.page));
  }
  if (parsed.branch !== undefined) {
    u.searchParams.set("branch", parsed.branch);
  }
  if (parsed.event !== undefined) {
    u.searchParams.set("event", parsed.event);
  }
  if (parsed.status !== undefined) {
    u.searchParams.set("status", parsed.status);
  }
  const res = await ghFetch(token, `${u.pathname}${u.search}`);
  return mcpJsonResultIfOk("GitHub Actions", res);
});

const runIdSchema = repoSlugArgs.extend({
  runId: z.number().int().min(1),
});

reg("gha_run_get", "Get a single workflow run by id.", runIdSchema, async (parsed) => {
  const token = requireProcessEnv("GITHUB_PAT");
  const path = `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/actions/runs/${String(parsed.runId)}`;
  const res = await ghFetch(token, path);
  return mcpJsonResultIfOk("GitHub Actions", res);
});

reg("gha_run_jobs", "List jobs for a workflow run.", runIdSchema, async (parsed) => {
  const token = requireProcessEnv("GITHUB_PAT");
  const path = `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/actions/runs/${String(parsed.runId)}/jobs`;
  const res = await ghFetch(token, path);
  return mcpJsonResultIfOk("GitHub Actions", res);
});

reg(
  "gha_run_log",
  "Download console log text for a job (truncated).",
  repoSlugArgs.extend({
    jobId: z.number().int().min(1),
    maxChars: z.number().int().min(1000).max(500_000).optional(),
  }),
  async (parsed) => {
    const token = requireProcessEnv("GITHUB_PAT");
    const url = `${GH_API}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/actions/jobs/${String(parsed.jobId)}/logs`;
    const res = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "follow",
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`GitHub Actions logs ${String(res.status)}: ${text.slice(0, 400)}`);
    }
    const max = parsed.maxChars ?? 64_000;
    const tail = text.length > max ? text.slice(-max) : text;
    return jsonResult({
      jobId: parsed.jobId,
      truncated: text.length > max,
      totalChars: text.length,
      text: tail,
    });
  },
);

reg(
  "gha_run_trigger",
  "Dispatch a workflow (workflow_dispatch). Requires Gateway HITL.",
  repoSlugArgs.extend({
    workflowId: z
      .string()
      .min(1)
      .describe("Numeric workflow id or workflow file name (e.g. ci.yml)"),
    ref: z.string().min(1).optional(),
    inputs: z.record(z.string(), z.string()).optional(),
  }),
  async (parsed) => {
    const token = requireProcessEnv("GITHUB_PAT");
    const encOwner = encodeURIComponent(parsed.owner);
    const encRepo = encodeURIComponent(parsed.repo);
    const encWf = encodeURIComponent(parsed.workflowId);
    const path = `/repos/${encOwner}/${encRepo}/actions/workflows/${encWf}/dispatches`;
    const ref = parsed.ref ?? "main";
    const res = await ghFetch(token, path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ref,
        inputs: parsed.inputs ?? {},
      }),
    });
    if (!res.ok) {
      throw new Error(`GitHub Actions dispatch ${String(res.status)}: ${res.text.slice(0, 400)}`);
    }
    return jsonResult({
      ok: true,
      owner: parsed.owner,
      repo: parsed.repo,
      workflowId: parsed.workflowId,
    });
  },
);

reg(
  "gha_run_cancel",
  "Cancel a workflow run. Requires Gateway HITL.",
  runIdSchema,
  async (parsed) => {
    const token = requireProcessEnv("GITHUB_PAT");
    const encOwner = encodeURIComponent(parsed.owner);
    const encRepo = encodeURIComponent(parsed.repo);
    const path = `/repos/${encOwner}/${encRepo}/actions/runs/${String(parsed.runId)}/cancel`;
    const res = await ghFetch(token, path, { method: "POST" });
    if (!res.ok) {
      throw new Error(`GitHub Actions cancel ${String(res.status)}: ${res.text.slice(0, 400)}`);
    }
    return jsonResult({ ok: true, runId: parsed.runId });
  },
);

const transport = new StdioServerTransport();
await mcp.connect(transport);
