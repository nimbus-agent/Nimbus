import type { Database } from "bun:sqlite";

import {
  boundTestCapabilities,
  createStubVault,
  silentSyncContextExtras,
} from "../connectors/connector-sync-test-helpers.ts";
import { createJiraSyncable } from "../connectors/jira-sync.ts";
import { PROJECTS_QUERY } from "../connectors/linear-projects.ts";
import { createLinearSyncable } from "../connectors/linear-sync.ts";
import { encodeNimbusJsonCursor } from "../connectors/nimbus-json-cursor.ts";

/**
 * Seeds Jira and Linear rows through the REAL sync writers, never a hand-built `INSERT INTO item`:
 * the pre-mortem readers filter on metadata keys, and a fixture that invents them proves nothing
 * about what a connector writes (a filter on a key no connector writes matches nothing in production).
 */

export type JiraFixtureEpic = {
  key: string;
  summary?: string;
  /** Jira `statusCategory.key`; `"done"` by default. */
  category?: string;
  created?: string;
  resolved?: string;
};

export type JiraFixtureChild = { key: string; parentKey: string };

function jiraIssue(
  id: number,
  key: string,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: String(id),
    key,
    fields: { summary: key, updated: "2026-02-01T00:00:00.000Z", ...fields },
  };
}

/** Runs the real Jira sync against a stubbed search endpoint. */
export async function seedJiraViaSync(
  db: Database,
  input: { epics: readonly JiraFixtureEpic[]; children?: readonly JiraFixtureChild[] },
): Promise<void> {
  let n = 20_000;
  const issues: Array<Record<string, unknown>> = [];
  for (const e of input.epics) {
    n += 1;
    issues.push(
      jiraIssue(n, e.key, {
        summary: e.summary ?? e.key,
        created: e.created ?? "2026-01-01T00:00:00.000Z",
        resolutiondate: e.resolved ?? "2026-01-20T00:00:00.000Z",
        issuetype: { name: "Epic" },
        status: { name: "Done", statusCategory: { key: e.category ?? "done" } },
      }),
    );
  }
  for (const c of input.children ?? []) {
    n += 1;
    issues.push(
      jiraIssue(n, c.key, {
        issuetype: { name: "Task" },
        status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
        parent: { key: c.parentKey },
      }),
    );
  }
  const vault = createStubVault({
    "jira.email": "u@example.com",
    "jira.api_token": "tok",
    "jira.base_url": "https://example.atlassian.net",
  });
  const ctx = {
    db,
    vault,
    ...silentSyncContextExtras(),
    ...boundTestCapabilities(db, vault, "jira"),
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input2: unknown): Promise<Response> => {
    const url = typeof input2 === "string" ? input2 : String((input2 as { url?: string }).url);
    if (url.includes("/rest/api/3/search")) {
      return new Response(
        JSON.stringify({ issues, startAt: 0, maxResults: 50, total: issues.length }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const cursor = encodeNimbusJsonCursor("nimbus-jra1:", {
      v: 1,
      floorJql: null,
      snapAt: Date.now(),
      ocAt: Date.now(),
      alAt: Date.now(),
    });
    await createJiraSyncable({ ensureJiraMcpRunning: async () => {} }).sync(
      ctx as unknown as Parameters<ReturnType<typeof createJiraSyncable>["sync"]>[0],
      cursor,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

export type LinearFixtureProject = {
  id: string;
  name: string;
  slugId?: string;
  /** Linear `ProjectStatusType`; `"completed"` by default. */
  statusType?: string;
  createdAt?: string;
  completedAt?: string | null;
  canceledAt?: string | null;
  updatedAt?: string;
  content?: string | null;
};

export type LinearFixtureIssue = { identifier: string; projectId: string | null };

function linearProjectNode(p: LinearFixtureProject): Record<string, unknown> {
  const type = p.statusType ?? "completed";
  return {
    id: p.id,
    name: p.name,
    description: "",
    content: p.content ?? null,
    slugId: p.slugId ?? `slug-${p.id}`,
    url: `https://linear.app/acme/project/${p.name.toLowerCase().replaceAll(" ", "-")}-${p.slugId ?? p.id}`,
    createdAt: p.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: p.updatedAt ?? "2026-03-01T00:00:00.000Z",
    startedAt: null,
    completedAt:
      p.completedAt === undefined
        ? type === "completed"
          ? "2026-02-01T00:00:00.000Z"
          : null
        : p.completedAt,
    canceledAt:
      p.canceledAt === undefined
        ? type === "canceled"
          ? "2026-02-01T00:00:00.000Z"
          : null
        : p.canceledAt,
    archivedAt: null,
    targetDate: null,
    status: type === "" ? null : { type, name: type },
  };
}

function linearIssueNode(i: LinearFixtureIssue): Record<string, unknown> {
  return {
    id: `uuid-${i.identifier}`,
    identifier: i.identifier,
    title: i.identifier,
    updatedAt: "2026-04-01T12:00:00.000Z",
    url: `https://linear.app/acme/issue/${i.identifier}`,
    state: { name: "In Progress", type: "started" },
    ...(i.projectId === null ? {} : { project: { id: i.projectId, name: "x" } }),
  };
}

/** Runs the real Linear sync (issues, then the project pass) against a stubbed GraphQL endpoint. */
export async function seedLinearViaSync(
  db: Database,
  input: { projects: readonly LinearFixtureProject[]; issues?: readonly LinearFixtureIssue[] },
): Promise<void> {
  const vault = createStubVault({ "linear.api_key": "key" });
  const ctx = {
    db,
    vault,
    ...silentSyncContextExtras(),
    ...boundTestCapabilities(db, vault, "linear"),
  };
  // A limiter that never waits: this seeds fixtures, it does not test the token bucket.
  (ctx as { rateLimiter: unknown }).rateLimiter = {
    acquire: async () => undefined,
    tryAcquire: async () => true,
    penalise: () => undefined,
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }): Promise<Response> => {
    const req = JSON.parse(String(init?.body)) as { query: string };
    if (req.query === PROJECTS_QUERY) {
      return new Response(
        JSON.stringify({
          data: {
            projects: {
              nodes: input.projects.map(linearProjectNode),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({
        data: {
          issues: {
            nodes: (input.issues ?? []).map(linearIssueNode),
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  try {
    // A fresh snapshot attempt, so only the issue and project requests are made.
    const cursor = encodeNimbusJsonCursor("nimbus-lnr1:", {
      since: "2020-01-01T00:00:00.000Z",
      snapAt: Date.now(),
    });
    await createLinearSyncable({ ensureLinearMcpRunning: async () => {} }).sync(
      ctx as unknown as Parameters<ReturnType<typeof createLinearSyncable>["sync"]>[0],
      cursor,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}
