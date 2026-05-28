import { z } from "zod";

import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { filterWizIssues } from "./search-filter.ts";

const DEFAULT_API = "https://api.app.wiz.io/graphql";
const DEFAULT_AUTH = "https://auth.app.wiz.io/oauth/token";
const SEVERITIES = ["INFORMATIONAL", "LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
const STATUSES = ["OPEN", "IN_PROGRESS", "RESOLVED", "REJECTED"] as const;

function apiUrl(): string {
  const v = process.env["WIZ_API_URL"]?.trim();
  return v === undefined || v === "" ? DEFAULT_API : v;
}

function authUrl(): string {
  const v = process.env["WIZ_AUTH_URL"]?.trim();
  return v === undefined || v === "" ? DEFAULT_AUTH : v;
}

async function fetchAccessToken(): Promise<string> {
  const clientId = process.env["WIZ_CLIENT_ID"]?.trim();
  const clientSecret = process.env["WIZ_CLIENT_SECRET"]?.trim();
  if (clientId === undefined || clientId === "") {
    throw new Error("WIZ_CLIENT_ID is not set");
  }
  if (clientSecret === undefined || clientSecret === "") {
    throw new Error("WIZ_CLIENT_SECRET is not set");
  }
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    audience: "wiz-api",
  });
  const res = await fetch(authUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Wiz auth ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  const parsed = JSON.parse(text) as { access_token?: string };
  if (typeof parsed.access_token !== "string" || parsed.access_token === "") {
    throw new Error("Wiz auth: missing access_token in response");
  }
  return parsed.access_token;
}

let cachedToken: string | undefined;
async function getToken(): Promise<string> {
  if (cachedToken === undefined) {
    cachedToken = await fetchAccessToken();
  }
  return cachedToken;
}

async function wizGraphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const token = await getToken();
  const res = await fetch(apiUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Wiz ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  const parsed = JSON.parse(text) as { data?: T; errors?: unknown };
  if (parsed.errors !== undefined) {
    throw new Error(`Wiz GraphQL error: ${JSON.stringify(parsed.errors).slice(0, 400)}`);
  }
  if (parsed.data === undefined) {
    throw new Error("Wiz GraphQL: response missing `data` field");
  }
  return parsed.data;
}

const ISSUES_QUERY = `
query Issues($first: Int!, $after: String, $filterBy: IssueFilters) {
  issues(first: $first, after: $after, filterBy: $filterBy) {
    nodes {
      id
      sourceRule { id name }
      severity
      status
      type
      createdAt
      updatedAt
      resolvedAt
      description
      remediation
      entity { id name type }
      projects { id name slug }
    }
    pageInfo { hasNextPage endCursor }
  }
}
`;

const SINGLE_ISSUE_QUERY = `
query Issue($id: ID!) {
  issue(id: $id) {
    id
    sourceRule { id name }
    severity
    status
    type
    createdAt
    updatedAt
    resolvedAt
    description
    remediation
    entity { id name type }
    projects { id name slug }
  }
}
`;

interface IssuesPage {
  readonly issues: {
    readonly nodes: readonly unknown[];
    readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null };
  };
}

await runReadOnlyMcpConnector("nimbus-wiz", (reg) => {
  reg(
    "wiz_list",
    "List Wiz issues. Filters map to the `IssueFilters` GraphQL input — severity, status, and entity type are all optional. Defaults to open issues across all severities, capped at 100.",
    z.object({
      severity: z.array(z.enum(SEVERITIES)).min(1).optional(),
      status: z.array(z.enum(STATUSES)).min(1).optional(),
      entityType: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async (p) => {
      const filterBy: Record<string, unknown> = {};
      filterBy["status"] = p.status ?? ["OPEN"];
      if (p.severity !== undefined && p.severity.length > 0) {
        filterBy["severity"] = p.severity;
      }
      if (p.entityType !== undefined) {
        filterBy["entityType"] = p.entityType;
      }
      const data = await wizGraphql<IssuesPage>(ISSUES_QUERY, {
        first: p.limit ?? 100,
        after: null,
        filterBy,
      });
      return jsonResult(data.issues);
    },
  );

  reg(
    "wiz_get",
    "Fetch one Wiz issue by its id. Throws when no match is found.",
    z.object({
      issueId: z.string().min(1),
    }),
    async (p) => {
      const data = await wizGraphql<{ issue: unknown | null }>(SINGLE_ISSUE_QUERY, {
        id: p.issueId,
      });
      if (data.issue === null) {
        throw new Error(`Wiz: issue ${p.issueId} not found`);
      }
      return jsonResult(data.issue);
    },
  );

  reg(
    "wiz_search",
    "Substring search across open issues. Matches the query against `sourceRule.name`, `description`, `entity.name`, `entity.type`, and project names (case-insensitive). Returns a `{ matches: [...] }` envelope.",
    z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    async (p) => {
      const data = await wizGraphql<IssuesPage>(ISSUES_QUERY, {
        first: 500,
        after: null,
        filterBy: { status: ["OPEN"] },
      });
      const matches = filterWizIssues(data.issues.nodes, { query: p.query, limit: p.limit });
      return jsonResult({ matches });
    },
  );
});
