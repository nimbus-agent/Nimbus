import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createWriteToolRegistrar } from "../../shared/consent-kit.ts";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
  requireProcessEnv,
} from "../../shared/mcp-tool-kit.ts";
import { makeRestFetcher, makeRestToolRegistrar } from "../../shared/rest-tool-kit.ts";

const GH_API = "https://api.github.com";
const GH_HEADERS: Record<string, string> = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

function ghFetch(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  return makeRestFetcher({ apiBase: GH_API, token, defaultHeaders: GH_HEADERS })(path, init);
}

const mcp = new McpServer({ name: "nimbus-github-actions", version: "0.1.0" });
const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));

/**
 * Every MUTATING github-actions tool goes through here. Outside the gateway this adds the
 * consent gate, the write-scope allow-list, the mutation budget and the audit record; inside
 * the gateway it is a pass-through, because executor.ts (I2) is the gate there.
 */
const registerWriteTool = createWriteToolRegistrar(mcp, {
  connector: "github-actions",
  scopeEnv: "NIMBUS_MCP_GITHUB_ACTIONS_WRITE_SCOPE",
  scopeKinds: ["repo"],
});

/** Standard GitHub Actions tool: token → ghFetch(buildPath) → mcpJsonResultIfOk("GitHub Actions"). */
const registerGhaTool = makeRestToolRegistrar({
  registrar: reg,
  tokenEnv: "GITHUB_PAT",
  serviceLabel: "GitHub Actions",
  fetch: ghFetch,
});

const slug = (owner: string, repo: string): string =>
  `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

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

registerGhaTool(
  "gha_workflow_list",
  "List GitHub Actions workflows for a repository.",
  repoSlugArgs.extend({
    perPage: z.number().int().min(1).max(100).optional(),
    page: z.number().int().min(1).optional(),
  }),
  (parsed) => {
    const u = new URL(`${GH_API}${slug(parsed.owner, parsed.repo)}/actions/workflows`);
    u.searchParams.set("per_page", String(parsed.perPage ?? 30));
    if (parsed.page !== undefined) {
      u.searchParams.set("page", String(parsed.page));
    }
    return `${u.pathname}${u.search}`;
  },
);

registerGhaTool("gha_run_list", "List workflow runs for a repository.", runListSchema, (parsed) => {
  const u = new URL(`${GH_API}${slug(parsed.owner, parsed.repo)}/actions/runs`);
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
  return `${u.pathname}${u.search}`;
});

const runIdSchema = repoSlugArgs.extend({
  runId: z.number().int().min(1),
});

registerGhaTool(
  "gha_run_get",
  "Get a single workflow run by id.",
  runIdSchema,
  (parsed) => `${slug(parsed.owner, parsed.repo)}/actions/runs/${String(parsed.runId)}`,
);

registerGhaTool(
  "gha_run_jobs",
  "List jobs for a workflow run.",
  runIdSchema,
  (parsed) => `${slug(parsed.owner, parsed.repo)}/actions/runs/${String(parsed.runId)}/jobs`,
);

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

registerWriteTool(
  "gha_run_trigger",
  {
    mutates: "github_actions.run.trigger",
    recoverable: true,
    scopeTargetOf: (p) => ({ kind: "repo", value: `${p.owner}/${p.repo}` }),
  },
  "Dispatch a workflow (workflow_dispatch).",
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
    const encWf = encodeURIComponent(parsed.workflowId);
    const path = `${slug(parsed.owner, parsed.repo)}/actions/workflows/${encWf}/dispatches`;
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

registerWriteTool(
  "gha_run_cancel",
  {
    mutates: "github_actions.run.cancel",
    recoverable: true,
    scopeTargetOf: (p) => ({ kind: "repo", value: `${p.owner}/${p.repo}` }),
  },
  "Cancel a workflow run.",
  runIdSchema,
  async (parsed) => {
    const token = requireProcessEnv("GITHUB_PAT");
    const path = `${slug(parsed.owner, parsed.repo)}/actions/runs/${String(parsed.runId)}/cancel`;
    const res = await ghFetch(token, path, { method: "POST" });
    if (!res.ok) {
      throw new Error(`GitHub Actions cancel ${String(res.status)}: ${res.text.slice(0, 400)}`);
    }
    return jsonResult({ ok: true, runId: parsed.runId });
  },
);

const transport = new StdioServerTransport();
await mcp.connect(transport);
