import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createWriteToolRegistrar } from "../../shared/consent-kit.ts";
import { joinApiPath } from "../../shared/join-api-path.ts";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResultIfOk,
} from "../../shared/mcp-tool-kit.ts";

const BB_API = "https://api.bitbucket.org/2.0";

function requireUsername(): string {
  const t = process.env["BITBUCKET_USERNAME"];
  if (t === undefined || t === "") {
    throw new Error("BITBUCKET_USERNAME is not set");
  }
  return t;
}

function requireAppPassword(): string {
  const t = process.env["BITBUCKET_APP_PASSWORD"];
  if (t === undefined || t === "") {
    throw new Error("BITBUCKET_APP_PASSWORD is not set");
  }
  return t;
}

function basicAuthHeader(): string {
  const user = requireUsername();
  const pass = requireAppPassword();
  const b = Buffer.from(`${user}:${pass}`, "utf8").toString("base64");
  return `Basic ${b}`;
}

function splitRepoFull(full: string): { workspace: string; repoSlug: string } {
  const i = full.indexOf("/");
  if (i <= 0 || i === full.length - 1) {
    throw new Error("repoFull must be workspace/repo_slug");
  }
  return { workspace: full.slice(0, i), repoSlug: full.slice(i + 1) };
}

async function bbFetch(
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const url = joinApiPath(BB_API, path);
  const baseHeaders: Record<string, string> = {
    Authorization: basicAuthHeader(),
    Accept: "application/json",
  };
  const extra = init?.headers as Record<string, string> | undefined;
  const headers = extra === undefined ? baseHeaders : { ...baseHeaders, ...extra };
  const res = await fetch(url, {
    ...init,
    headers,
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

const server = new McpServer({ name: "nimbus-bitbucket", version: "0.1.0" });

const registerSimpleTool = createRegisterSimpleTool(server);
const reg = createZodToolRegistrar(registerSimpleTool);

/**
 * Every MUTATING bitbucket tool goes through here. Outside the gateway this adds the
 * consent gate, the write-scope allow-list, the mutation budget and the audit record; inside
 * the gateway it is a pass-through, because executor.ts (I2) is the gate there.
 */
const registerWriteTool = createWriteToolRegistrar(server, {
  connector: "bitbucket",
  scopeEnv: "NIMBUS_MCP_BITBUCKET_WRITE_SCOPE",
  scopeKinds: ["repo"],
});

const repoFullArg = z.object({
  repoFull: z
    .string()
    .min(3)
    .describe("Repository full name: workspace/repo_slug (e.g. myteam/my-service)"),
});

const bitbucketRepoListSchema = z.object({
  pagelen: z.number().int().min(1).max(100).optional(),
  page: z.string().max(2000).optional().describe("Opaque page URL or token from a prior next link"),
});

reg(
  "bitbucket_repo_list",
  "List repositories where the authenticated user is a member.",
  bitbucketRepoListSchema,
  async (parsed) => {
    if (parsed.page?.startsWith("http")) {
      const res = await bbFetch(parsed.page);
      return mcpJsonResultIfOk("Bitbucket", res);
    }
    const qs = new URLSearchParams();
    qs.set("role", "member");
    qs.set("pagelen", String(parsed.pagelen ?? 30));
    const res = await bbFetch(`/repositories?${qs.toString()}`);
    return mcpJsonResultIfOk("Bitbucket", res);
  },
);

const bitbucketPrListSchema = repoFullArg.extend({
  state: z.enum(["OPEN", "MERGED", "DECLINED", "SUPERSEDED"]).optional(),
  pagelen: z.number().int().min(1).max(100).optional(),
  page: z.string().max(2000).optional().describe("Opaque next URL from a prior response"),
});

reg(
  "bitbucket_pr_list",
  "List pull requests for a repository.",
  bitbucketPrListSchema,
  async (parsed) => {
    if (parsed.page?.startsWith("http")) {
      const res = await bbFetch(parsed.page);
      return mcpJsonResultIfOk("Bitbucket", res);
    }
    const { workspace, repoSlug } = splitRepoFull(parsed.repoFull);
    const base = `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}/pullrequests`;
    const qs = new URLSearchParams();
    qs.set("pagelen", String(parsed.pagelen ?? 30));
    qs.set("sort", "-updated_on");
    if (parsed.state !== undefined) {
      qs.set("q", `state="${parsed.state}"`);
    }
    const res = await bbFetch(`${base}?${qs.toString()}`);
    return mcpJsonResultIfOk("Bitbucket", res);
  },
);

const bitbucketPrGetSchema = repoFullArg.extend({
  pullRequestId: z.number().int().min(1),
});

reg(
  "bitbucket_pr_get",
  "Get a single pull request by numeric id.",
  bitbucketPrGetSchema,
  async (parsed) => {
    const { workspace, repoSlug } = splitRepoFull(parsed.repoFull);
    const path = `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}/pullrequests/${String(parsed.pullRequestId)}`;
    const res = await bbFetch(path);
    return mcpJsonResultIfOk("Bitbucket", res);
  },
);

const bitbucketPrMergeSchema = repoFullArg.extend({
  pullRequestId: z.number().int().min(1),
  mergeStrategy: z.enum(["merge_commit", "squash", "fast_forward"]).optional(),
  message: z.string().max(32_768).optional(),
});

registerWriteTool(
  "bitbucket_pr_merge",
  {
    mutates: "bitbucket.pr.merge",
    recoverable: true,
    scopeTargetOf: (p) => ({ kind: "repo", value: p.repoFull }),
  },
  "Merge a pull request.",
  bitbucketPrMergeSchema,
  async (parsed) => {
    const { workspace, repoSlug } = splitRepoFull(parsed.repoFull);
    const path = `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}/pullrequests/${String(parsed.pullRequestId)}/merge`;
    const body: Record<string, unknown> = { type: "pullrequest" };
    if (parsed.mergeStrategy !== undefined) {
      body["merge_strategy"] = parsed.mergeStrategy;
    }
    if (parsed.message !== undefined) {
      body["message"] = parsed.message;
    }
    const res = await bbFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return mcpJsonResultIfOk("Bitbucket", res);
  },
);

const bitbucketRepoPagedSchema = repoFullArg.extend({
  pagelen: z.number().int().min(1).max(100).optional(),
  page: z.string().max(2000).optional(),
});

reg(
  "bitbucket_pipeline_list",
  "List Pipelines runs for a repository.",
  bitbucketRepoPagedSchema,
  async (parsed) => {
    if (parsed.page?.startsWith("http")) {
      const res = await bbFetch(parsed.page);
      return mcpJsonResultIfOk("Bitbucket", res);
    }
    const { workspace, repoSlug } = splitRepoFull(parsed.repoFull);
    const base = `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}/pipelines/`;
    const qs = new URLSearchParams();
    qs.set("pagelen", String(parsed.pagelen ?? 30));
    const res = await bbFetch(`${base}?${qs.toString()}`);
    return mcpJsonResultIfOk("Bitbucket", res);
  },
);

const bitbucketPipelineGetSchema = repoFullArg.extend({
  pipelineUuid: z.string().min(8).max(128),
});

reg(
  "bitbucket_pipeline_get",
  "Get a single pipeline run by UUID.",
  bitbucketPipelineGetSchema,
  async (parsed) => {
    const { workspace, repoSlug } = splitRepoFull(parsed.repoFull);
    const encUuid = encodeURIComponent(parsed.pipelineUuid);
    const path = `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}/pipelines/${encUuid}`;
    const res = await bbFetch(path);
    return mcpJsonResultIfOk("Bitbucket", res);
  },
);

reg(
  "bitbucket_issue_list",
  "List issues for a repository (issue tracker must be enabled).",
  bitbucketRepoPagedSchema,
  async (parsed) => {
    if (parsed.page?.startsWith("http")) {
      const res = await bbFetch(parsed.page);
      return mcpJsonResultIfOk("Bitbucket", res);
    }
    const { workspace, repoSlug } = splitRepoFull(parsed.repoFull);
    const base = `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}/issues`;
    const qs = new URLSearchParams();
    qs.set("pagelen", String(parsed.pagelen ?? 30));
    const res = await bbFetch(`${base}?${qs.toString()}`);
    return mcpJsonResultIfOk("Bitbucket", res);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
