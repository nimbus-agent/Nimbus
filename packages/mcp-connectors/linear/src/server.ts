import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
  requireProcessEnv,
} from "../../shared/mcp-tool-kit.ts";

const LINEAR_GQL = "https://api.linear.app/graphql";

type LinearGqlResponse<T> = {
  data?: T;
  errors?: ReadonlyArray<{ message: string }>;
};

async function linearGraphql<T>(
  apiKey: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<{ ok: true; data: T; text: string } | { ok: false; status: number; text: string }> {
  const res = await fetch(LINEAR_GQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, text };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, status: res.status, text: "invalid JSON" };
  }
  const body = parsed as LinearGqlResponse<T>;
  if (body.errors !== undefined && body.errors.length > 0) {
    const msg = body.errors.map((e) => e.message).join("; ");
    throw new Error(`Linear GraphQL: ${msg.slice(0, 400)}`);
  }
  if (body.data === undefined) {
    throw new Error("Linear GraphQL: missing data");
  }
  return { ok: true, data: body.data, text };
}

function linearGqlData<T>(
  res: { ok: true; data: T; text: string } | { ok: false; status: number; text: string },
): T {
  if (!res.ok) {
    throw new Error(`Linear ${String(res.status)}: ${res.text.slice(0, 300)}`);
  }
  return res.data;
}

const server = new McpServer({ name: "nimbus-linear", version: "0.1.0" });

const registerSimpleTool = createRegisterSimpleTool(server);

import { createWriteToolRegistrar } from "../../shared/consent-kit.ts";

const reg = createZodToolRegistrar(registerSimpleTool);

/**
 * Every MUTATING linear tool goes through here. Outside the gateway this adds the
 * consent gate, the write-scope allow-list, the mutation budget and the audit record; inside
 * the gateway it is a pass-through, because executor.ts (I2) is the gate there.
 */
const registerWriteTool = createWriteToolRegistrar(server, {
  connector: "linear",
  scopeEnv: "NIMBUS_MCP_LINEAR_WRITE_SCOPE",
  scopeKinds: ["team", "issue"],
});

const linearIssueListSchema = z.object({
  first: z.number().int().min(1).max(100).optional(),
  teamId: z.string().min(1).optional(),
  stateName: z.string().min(1).optional(),
  assigneeId: z.string().min(1).optional(),
});

reg(
  "linear_issue_list",
  "List Linear issues with optional filters (team id, state name, assignee id).",
  linearIssueListSchema,
  async (parsed) => {
    const apiKey = requireProcessEnv("LINEAR_API_KEY");
    const filter: Record<string, unknown> = {};
    if (parsed.teamId !== undefined) {
      filter["team"] = { id: { eq: parsed.teamId } };
    }
    if (parsed.stateName !== undefined) {
      filter["state"] = { name: { eq: parsed.stateName } };
    }
    if (parsed.assigneeId !== undefined) {
      filter["assignee"] = { id: { eq: parsed.assigneeId } };
    }
    const hasFilter = Object.keys(filter).length > 0;
    const q = hasFilter
      ? `
      query IssueList($first: Int!, $filter: IssueFilter!) {
        issues(first: $first, filter: $filter, orderBy: updatedAt) {
          nodes {
            id
            identifier
            title
            updatedAt
            url
            state { id name type }
            team { id name key }
          }
        }
      }
    `
      : `
      query IssueList($first: Int!) {
        issues(first: $first, orderBy: updatedAt) {
          nodes {
            id
            identifier
            title
            updatedAt
            url
            state { id name type }
            team { id name key }
          }
        }
      }
    `;
    type Out = {
      issues: {
        nodes: ReadonlyArray<Record<string, unknown>>;
      };
    };
    const vars: Record<string, unknown> = { first: parsed.first ?? 50 };
    if (hasFilter) {
      vars["filter"] = filter;
    }
    const res = await linearGraphql<Out>(apiKey, q, vars);
    return jsonResult(linearGqlData(res));
  },
);

const linearIssueIdSchema = z.object({ issueId: z.string().min(1) });

reg(
  "linear_issue_get",
  "Get a single Linear issue by UUID id.",
  linearIssueIdSchema,
  async (parsed) => {
    const apiKey = requireProcessEnv("LINEAR_API_KEY");
    const q = `
      query IssueGet($id: String!) {
        issue(id: $id) {
          id
          identifier
          title
          description
          updatedAt
          createdAt
          url
          priority
          state { id name type }
          team { id name key }
          assignee { id name displayName }
        }
      }
    `;
    type Out = { issue: Record<string, unknown> | null };
    const res = await linearGraphql<Out>(apiKey, q, { id: parsed.issueId });
    return jsonResult(linearGqlData(res));
  },
);

const linearIssueCreateSchema = z.object({
  teamId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  priority: z.number().int().min(0).max(4).optional(),
  stateId: z.string().min(1).optional(),
  assigneeId: z.string().min(1).optional(),
});

registerWriteTool(
  "linear_issue_create",
  {
    mutates: "linear.issue.create",
    recoverable: true,
    scopeTargetOf: (p) => ({ kind: "team", value: p.teamId }),
  },
  "Create a Linear issue (requires teamId and title).",
  linearIssueCreateSchema,
  async (parsed) => {
    const apiKey = requireProcessEnv("LINEAR_API_KEY");
    const input: Record<string, unknown> = {
      teamId: parsed.teamId,
      title: parsed.title,
    };
    if (parsed.description !== undefined) {
      input["description"] = parsed.description;
    }
    if (parsed.priority !== undefined) {
      input["priority"] = parsed.priority;
    }
    if (parsed.stateId !== undefined) {
      input["stateId"] = parsed.stateId;
    }
    if (parsed.assigneeId !== undefined) {
      input["assigneeId"] = parsed.assigneeId;
    }
    const q = `
      mutation IssueCreate($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id identifier url title }
        }
      }
    `;
    type Out = { issueCreate: { success: boolean; issue: Record<string, unknown> | null } };
    const res = await linearGraphql<Out>(apiKey, q, { input });
    return jsonResult(linearGqlData(res));
  },
);

const linearIssueUpdateSchema = z.object({
  issueId: z.string().min(1),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  stateId: z.string().min(1).optional(),
  priority: z.number().int().min(0).max(4).optional(),
  assigneeId: z.string().min(1).optional(),
});

registerWriteTool(
  "linear_issue_update",
  {
    mutates: "linear.issue.update",
    recoverable: true,
    scopeTargetOf: (p) => ({ kind: "issue", value: p.issueId }),
  },
  "Update a Linear issue by id.",
  linearIssueUpdateSchema,
  async (parsed) => {
    const apiKey = requireProcessEnv("LINEAR_API_KEY");
    const input: Record<string, unknown> = {};
    if (parsed.title !== undefined) {
      input["title"] = parsed.title;
    }
    if (parsed.description !== undefined) {
      input["description"] = parsed.description;
    }
    if (parsed.stateId !== undefined) {
      input["stateId"] = parsed.stateId;
    }
    if (parsed.priority !== undefined) {
      input["priority"] = parsed.priority;
    }
    if (parsed.assigneeId !== undefined) {
      input["assigneeId"] = parsed.assigneeId;
    }
    const q = `
      mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
          issue { id identifier url title updatedAt }
        }
      }
    `;
    type Out = {
      issueUpdate: { success: boolean; issue: Record<string, unknown> | null };
    };
    const res = await linearGraphql<Out>(apiKey, q, {
      id: parsed.issueId,
      input,
    });
    return jsonResult(linearGqlData(res));
  },
);

const linearCommentCreateSchema = z.object({
  issueId: z.string().min(1),
  body: z.string().min(1),
});

registerWriteTool(
  "linear_comment_create",
  {
    mutates: "linear.comment.create",
    recoverable: true,
    scopeTargetOf: (p) => ({ kind: "issue", value: p.issueId }),
  },
  "Add a comment to a Linear issue.",
  linearCommentCreateSchema,
  async (parsed) => {
    const apiKey = requireProcessEnv("LINEAR_API_KEY");
    const q = `
      mutation CommentCreate($input: CommentCreateInput!) {
        commentCreate(input: $input) {
          success
          comment { id body createdAt }
        }
      }
    `;
    type Out = {
      commentCreate: { success: boolean; comment: Record<string, unknown> | null };
    };
    const res = await linearGraphql<Out>(apiKey, q, {
      input: { issueId: parsed.issueId, body: parsed.body },
    });
    return jsonResult(linearGqlData(res));
  },
);

const linearFirstOptionalSchema = z.object({
  first: z.number().int().min(1).max(100).optional(),
});

reg("linear_project_list", "List Linear projects.", linearFirstOptionalSchema, async (parsed) => {
  const apiKey = requireProcessEnv("LINEAR_API_KEY");
  const q = `
      query ProjectList($first: Int!) {
        projects(first: $first) {
          nodes {
            id
            name
            description
            slugId
            url
            updatedAt
            state
          }
        }
      }
    `;
  type Out = { projects: { nodes: ReadonlyArray<Record<string, unknown>> } };
  const res = await linearGraphql<Out>(apiKey, q, { first: parsed.first ?? 50 });
  return jsonResult(linearGqlData(res));
});

const linearProjectIdSchema = z.object({ projectId: z.string().min(1) });

reg("linear_project_get", "Get a Linear project by id.", linearProjectIdSchema, async (parsed) => {
  const apiKey = requireProcessEnv("LINEAR_API_KEY");
  const q = `
      query ProjectGet($id: String!) {
        project(id: $id) {
          id
          name
          description
          slugId
          url
          updatedAt
          state
          lead { id displayName }
        }
      }
    `;
  type Out = { project: Record<string, unknown> | null };
  const res = await linearGraphql<Out>(apiKey, q, { id: parsed.projectId });
  return jsonResult(linearGqlData(res));
});

const linearCycleListSchema = z.object({
  teamId: z.string().min(1),
  first: z.number().int().min(1).max(50).optional(),
});

reg(
  "linear_cycle_list",
  "List Linear cycles for a team.",
  linearCycleListSchema,
  async (parsed) => {
    const apiKey = requireProcessEnv("LINEAR_API_KEY");
    const q = `
      query CycleList($teamId: ID!, $first: Int!) {
        team(id: $teamId) {
          id
          cycles(first: $first) {
            nodes {
              id
              name
              number
              startsAt
              endsAt
              completedAt
            }
          }
        }
      }
    `;
    type Out = {
      team: {
        id: string;
        cycles: { nodes: ReadonlyArray<Record<string, unknown>> };
      } | null;
    };
    const res = await linearGraphql<Out>(apiKey, q, {
      teamId: parsed.teamId,
      first: parsed.first ?? 20,
    });
    return jsonResult(linearGqlData(res));
  },
);

const linearRoadmapFirstSchema = z.object({
  first: z.number().int().min(1).max(50).optional(),
});

reg(
  "linear_roadmap_list",
  "List Linear initiatives (roadmap).",
  linearRoadmapFirstSchema,
  async (parsed) => {
    const apiKey = requireProcessEnv("LINEAR_API_KEY");
    const q = `
      query InitiativeList($first: Int!) {
        initiatives(first: $first) {
          nodes {
            id
            name
            description
            targetDate
            updatedAt
            url
          }
        }
      }
    `;
    type Out = { initiatives: { nodes: ReadonlyArray<Record<string, unknown>> } };
    const res = await linearGraphql<Out>(apiKey, q, { first: parsed.first ?? 30 });
    return jsonResult(linearGqlData(res));
  },
);

reg(
  "linear_member_list",
  "List users in the workspace.",
  linearFirstOptionalSchema,
  async (parsed) => {
    const apiKey = requireProcessEnv("LINEAR_API_KEY");
    const q = `
      query Users($first: Int!) {
        users(first: $first) {
          nodes {
            id
            name
            displayName
            email
            active
          }
        }
      }
    `;
    type Out = { users: { nodes: ReadonlyArray<Record<string, unknown>> } };
    const res = await linearGraphql<Out>(apiKey, q, { first: parsed.first ?? 50 });
    return jsonResult(linearGqlData(res));
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
