import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { createWriteToolRegistrar, type WriteToolConfig } from "../../shared/consent-kit.ts";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
  mcpJsonResultIfOk,
  requireProcessEnv,
  type ZodObjectSchema,
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

const server = new McpServer(
  { name: "nimbus-github", version: "0.1.0" },
  {
    // Machine-readable security tiering, so a client can surface it rather than relying on a
    // human having read the NOTICE file.
    instructions:
      "Nimbus GitHub connector. Standalone: mutating tools require MCP elicitation consent and " +
      "are limited by NIMBUS_MCP_GITHUB_WRITE_SCOPE; they are not registered at all if this " +
      "client does not support elicitation. No sandbox, no OS keychain and no egress ledger " +
      "outside the Nimbus gateway. See NOTICE.",
  },
);

const registerSimpleTool = createRegisterSimpleTool(server);
const reg = createZodToolRegistrar(registerSimpleTool);

/**
 * Every MUTATING GitHub tool goes through here. Outside the gateway this adds the consent gate,
 * the write-scope allow-list, the mutation budget and the audit record; inside the gateway it is a
 * pass-through, because executor.ts (I2) is the gate there.
 */
const registerWriteTool = createWriteToolRegistrar(server, {
  connector: "github",
  scopeEnv: "NIMBUS_MCP_GITHUB_WRITE_SCOPE",
  scopeKinds: ["repo"],
});

/**
 * The write-tool equivalent of `registerGithubTool`: same buildPath/buildInit shape, same fetch and
 * result handling, routed through the write registrar. `scopeTargetOf` is supplied here rather
 * than per tool — every GitHub mutation is scoped to one `owner/repo`, and deriving it centrally
 * means a new write tool cannot forget it.
 */
function registerGithubWriteTool<T extends { owner: string; repo: string }>(
  name: string,
  cfg: Omit<WriteToolConfig<T>, "scopeTargetOf">,
  description: string,
  schema: ZodObjectSchema<T>,
  buildPath: (parsed: T) => string,
  buildInit?: (parsed: T) => RequestInit,
): void {
  registerWriteTool(
    name,
    { ...cfg, scopeTargetOf: (p) => ({ kind: "repo", value: `${p.owner}/${p.repo}` }) },
    description,
    schema,
    async (parsed) => {
      const token = requireProcessEnv("GITHUB_PAT");
      const res = await ghFetch(token, buildPath(parsed), buildInit?.(parsed));
      return mcpJsonResultIfOk("GitHub", res);
    },
  );
}

/** Standard GitHub tool: token → ghFetch(buildPath[, buildInit]) → mcpJsonResultIfOk("GitHub"). */
const registerGithubTool = makeRestToolRegistrar({
  registrar: reg,
  tokenEnv: "GITHUB_PAT",
  serviceLabel: "GitHub",
  fetch: ghFetch,
});

const slug = (owner: string, repo: string): string =>
  `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const repoSlugArgs = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
});

const githubRepoListSchema = z.object({
  perPage: z.number().int().min(1).max(100).optional(),
  page: z.number().int().min(1).optional(),
});

registerGithubTool(
  "github_repo_list",
  "List repositories for the authenticated user (affiliation: owner, collaborator, organization_member).",
  githubRepoListSchema,
  (parsed) => {
    const u = new URL(`${GH_API}/user/repos`);
    u.searchParams.set("per_page", String(parsed.perPage ?? 30));
    if (parsed.page !== undefined) {
      u.searchParams.set("page", String(parsed.page));
    }
    u.searchParams.set("sort", "updated");
    u.searchParams.set("affiliation", "owner,collaborator,organization_member");
    return `${u.pathname}${u.search}`;
  },
);

registerGithubTool(
  "github_repo_get",
  "Get repository metadata (owner/repo).",
  repoSlugArgs,
  (parsed) => slug(parsed.owner, parsed.repo),
);

const githubPrListSchema = repoSlugArgs.extend({
  state: z.enum(["open", "closed", "all"]).optional(),
  perPage: z.number().int().min(1).max(100).optional(),
  page: z.number().int().min(1).optional(),
});

registerGithubTool(
  "github_pr_list",
  "List pull requests for a repository.",
  githubPrListSchema,
  (parsed) => {
    const u = new URL(`${GH_API}${slug(parsed.owner, parsed.repo)}/pulls`);
    u.searchParams.set("state", parsed.state ?? "open");
    u.searchParams.set("per_page", String(parsed.perPage ?? 30));
    if (parsed.page !== undefined) {
      u.searchParams.set("page", String(parsed.page));
    }
    u.searchParams.set("sort", "updated");
    u.searchParams.set("direction", "desc");
    return `${u.pathname}${u.search}`;
  },
);

const githubPrNumberSchema = repoSlugArgs.extend({
  pullNumber: z.number().int().min(1),
});

registerGithubTool(
  "github_pr_get",
  "Get a single pull request by number.",
  githubPrNumberSchema,
  (parsed) => `${slug(parsed.owner, parsed.repo)}/pulls/${String(parsed.pullNumber)}`,
);

const githubPrMergeSchema = repoSlugArgs.extend({
  pullNumber: z.number().int().min(1),
  mergeMethod: z.enum(["merge", "squash", "rebase"]).optional(),
  commitTitle: z.string().max(500).optional(),
});

registerGithubWriteTool(
  "github_pr_merge",
  { mutates: "github.pr.merge", recoverable: true },
  "Merge a pull request.",
  githubPrMergeSchema,
  (parsed) => `${slug(parsed.owner, parsed.repo)}/pulls/${String(parsed.pullNumber)}/merge`,
  (parsed) => {
    const body: Record<string, string> = {};
    if (parsed.mergeMethod !== undefined) {
      body["merge_method"] = parsed.mergeMethod;
    }
    if (parsed.commitTitle !== undefined && parsed.commitTitle !== "") {
      body["commit_title"] = parsed.commitTitle;
    }
    return jsonInit("PUT", body);
  },
);

registerGithubWriteTool(
  "github_pr_close",
  { mutates: "github.pr.close", recoverable: true },
  "Close a pull request without merging.",
  githubPrNumberSchema,
  (parsed) => `${slug(parsed.owner, parsed.repo)}/pulls/${String(parsed.pullNumber)}`,
  () => jsonInit("PATCH", { state: "closed" }),
);

const githubIssueListSchema = repoSlugArgs.extend({
  state: z.enum(["open", "closed", "all"]).optional(),
  perPage: z.number().int().min(1).max(100).optional(),
  page: z.number().int().min(1).optional(),
});

registerGithubTool(
  "github_issue_list",
  "List issues for a repository.",
  githubIssueListSchema,
  (parsed) => {
    const u = new URL(`${GH_API}${slug(parsed.owner, parsed.repo)}/issues`);
    u.searchParams.set("state", parsed.state ?? "open");
    u.searchParams.set("per_page", String(parsed.perPage ?? 30));
    if (parsed.page !== undefined) {
      u.searchParams.set("page", String(parsed.page));
    }
    u.searchParams.set("sort", "updated");
    u.searchParams.set("direction", "desc");
    return `${u.pathname}${u.search}`;
  },
);

const githubIssueGetSchema = repoSlugArgs.extend({
  issueNumber: z.number().int().min(1),
});

registerGithubTool(
  "github_issue_get",
  "Get a single issue by number.",
  githubIssueGetSchema,
  (parsed) => `${slug(parsed.owner, parsed.repo)}/issues/${String(parsed.issueNumber)}`,
);

const githubIssueCreateSchema = repoSlugArgs.extend({
  title: z.string().min(1).max(500),
  body: z.string().max(65_000).optional(),
});

registerGithubWriteTool(
  "github_issue_create",
  { mutates: "github.issue.create", recoverable: true },
  "Create a new issue in a repository.",
  githubIssueCreateSchema,
  (parsed) => `${slug(parsed.owner, parsed.repo)}/issues`,
  (parsed) => jsonInit("POST", { title: parsed.title, body: parsed.body }),
);

const githubCiRunsSchema = repoSlugArgs.extend({
  perPage: z.number().int().min(1).max(100).optional(),
  page: z.number().int().min(1).optional(),
});

registerGithubTool(
  "github_ci_runs",
  "List GitHub Actions workflow runs for a repository.",
  githubCiRunsSchema,
  (parsed) => {
    const u = new URL(`${GH_API}${slug(parsed.owner, parsed.repo)}/actions/runs`);
    u.searchParams.set("per_page", String(parsed.perPage ?? 30));
    if (parsed.page !== undefined) {
      u.searchParams.set("page", String(parsed.page));
    }
    return `${u.pathname}${u.search}`;
  },
);

const githubCiRunGetSchema = repoSlugArgs.extend({
  runId: z.number().int().min(1),
});

registerGithubTool(
  "github_ci_run_get",
  "Get a single workflow run including jobs URL reference.",
  githubCiRunGetSchema,
  (parsed) => `${slug(parsed.owner, parsed.repo)}/actions/runs/${String(parsed.runId)}`,
);

const githubBranchDeleteSchema = repoSlugArgs.extend({
  branch: z.string().min(1).max(255),
});

registerWriteTool(
  "github_branch_delete",
  {
    mutates: "github.branch.delete",
    // The only GitHub mutation here that cannot be undone from its own result, so the ref's SHA is
    // captured BEFORE the delete. With it the branch can be recreated; without it the commit is
    // only reachable by reflog on someone's clone.
    recoverable: false,
    capturePreState: async (parsed) => {
      const token = requireProcessEnv("GITHUB_PAT");
      const ref = `heads/${parsed.branch}`;
      const res = await ghFetch(
        token,
        `${slug(parsed.owner, parsed.repo)}/git/ref/${encodeURIComponent(ref)}`,
      );
      return { ref, resolved: res.ok, sha: res.json };
    },
    scopeTargetOf: (parsed) => ({ kind: "repo", value: `${parsed.owner}/${parsed.repo}` }),
  },
  "Delete a branch by ref name.",
  githubBranchDeleteSchema,
  async (parsed) => {
    const token = requireProcessEnv("GITHUB_PAT");
    const ref = `heads/${parsed.branch}`;
    const path = `${slug(parsed.owner, parsed.repo)}/git/refs/${encodeURIComponent(ref)}`;
    const res = await ghFetch(token, path, { method: "DELETE" });
    if (!res.ok && res.status !== 204) {
      throw new Error(`GitHub ${String(res.status)}: ${res.text.slice(0, 300)}`);
    }
    return jsonResult({ ok: true, deleted: ref });
  },
);

const githubTagCreateSchema = repoSlugArgs.extend({
  tag: z.string().min(1).max(255),
  sha: z.string().min(7).max(40),
});

registerGithubWriteTool(
  "github_tag_create",
  { mutates: "github.tag.create", recoverable: true },
  "Create a lightweight tag pointing at a commit SHA.",
  githubTagCreateSchema,
  (parsed) => `${slug(parsed.owner, parsed.repo)}/git/refs`,
  (parsed) => jsonInit("POST", { ref: `refs/tags/${parsed.tag}`, sha: parsed.sha }),
);

const githubCommitPushSchema = repoSlugArgs.extend({
  branch: z.string().min(1).optional(),
});

reg(
  "github_commit_push",
  "Push commits is not available via this tool — use local git with your own remote credentials (requires HITL repo.commit.push if ever implemented).",
  githubCommitPushSchema,
  async () =>
    jsonResult({
      code: "NOT_IMPLEMENTED",
      message:
        "Pushing commits requires local git and is not executed by this MCP server. Clone the repo and push with git.",
    }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
